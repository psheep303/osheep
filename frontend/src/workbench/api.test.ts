import assert from "node:assert/strict";
import test from "node:test";
import { ensureApiSession, http, readFile, resetApiSession } from "./api.ts";

function isSessionRequest(input: RequestInfo | URL): boolean {
  return String(input) === "/api/auth/session";
}

test("GET revalidation transparently reuses the cached body on 304", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  let call = 0;
  resetApiSession();
  globalThis.fetch = async (input, init) => {
    if (isSessionRequest(input)) return new Response(JSON.stringify({ ok: true }));
    requests.push(init ?? {});
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ value: 1 }), {
        status: 200,
        headers: { "content-type": "application/json", etag: 'W/"cached"' },
      });
    }
    return new Response(null, { status: 304, headers: { etag: 'W/"cached"' } });
  };

  try {
    assert.deepEqual(await http.get<{ value: number }>("/api/cache-hit"), { value: 1 });
    assert.deepEqual(await http.get<{ value: number }>("/api/cache-hit"), { value: 1 });
    assert.equal(new Headers(requests[0]?.headers).get("if-none-match"), null);
    assert.equal(new Headers(requests[1]?.headers).get("if-none-match"), 'W/"cached"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cacheless 304 retries without a conditional header", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  let call = 0;
  resetApiSession();
  globalThis.fetch = async (input, init) => {
    if (isSessionRequest(input)) return new Response(JSON.stringify({ ok: true }));
    requests.push(init ?? {});
    call += 1;
    if (call === 1) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ recovered: true }), {
      status: 200,
      headers: { "content-type": "application/json", etag: 'W/"recovered"' },
    });
  };

  try {
    assert.deepEqual(await http.get<{ recovered: boolean }>("/api/cache-miss"), {
      recovered: true,
    });
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[1]?.headers).get("if-none-match"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mutating requests do not use GET validators", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  resetApiSession();
  globalThis.fetch = async (input, init) => {
    if (isSessionRequest(input)) return new Response(JSON.stringify({ ok: true }));
    requests.push(init ?? {});
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", etag: 'W/"mutation"' },
    });
  };

  try {
    await http.post("/api/cache-hit", { value: 2 });
    assert.equal(new Headers(requests[0]?.headers).get("if-none-match"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an expired session is renewed once before retrying the API request", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let apiCalls = 0;
  resetApiSession();
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (isSessionRequest(input)) return new Response(JSON.stringify({ ok: true }));
    apiCalls += 1;
    if (apiCalls === 1) return new Response(null, { status: 401 });
    return new Response(JSON.stringify({ renewed: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    assert.deepEqual(await http.get<{ renewed: boolean }>("/api/session-renewal"), {
      renewed: true,
    });
    assert.deepEqual(calls, [
      "/api/auth/session",
      "/api/session-renewal",
      "/api/auth/session",
      "/api/session-renewal",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session setup retries a transient server failure while the backend starts", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  resetApiSession();
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/auth/session");
    attempts += 1;
    return attempts === 1
      ? new Response(JSON.stringify({ error: { code: "INTERNAL", message: "backend starting" } }), {
          status: 503,
        })
      : new Response(JSON.stringify({ ok: true }));
  };

  try {
    await ensureApiSession();
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("file reads carry the trace id and expose response timing metadata", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestHeaders = new Headers();
  resetApiSession();
  globalThis.fetch = async (input, init) => {
    if (isSessionRequest(input)) return new Response(JSON.stringify({ ok: true }));
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ content: "hello", size: 5, mtime: 123 }), {
      headers: {
        "content-type": "application/json",
        "server-timing": "osheep-file-read;dur=1.25",
        "x-osheep-file-cache": "miss",
      },
    });
  };

  try {
    const result = await readFile("demo", "hello world.txt", "trace-api-test");
    assert.equal(
      requestUrl,
      "/api/workspaces/demo/fs/file?path=hello+world.txt",
    );
    assert.equal(requestHeaders.get("x-osheep-file-open-id"), "trace-api-test");
    assert.equal(result.content, "hello");
    assert.equal(result.responseMetadata?.headers.get("server-timing"), "osheep-file-read;dur=1.25");
    assert.equal(typeof result.responseMetadata?.requestStartedAt, "number");
    assert.equal(typeof result.responseMetadata?.bodyReceivedAt, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
