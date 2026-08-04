import assert from "node:assert/strict";
import test from "node:test";
import { http } from "./api.ts";

test("GET revalidation transparently reuses the cached body on 304", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  let call = 0;
  globalThis.fetch = async (_input, init) => {
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
  globalThis.fetch = async (_input, init) => {
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
  globalThis.fetch = async (_input, init) => {
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
