import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { createSecurity, type SecurityOptions } from "./security.js";

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("; ") : (value ?? "");
}

async function securityApp(overrides: Partial<SecurityOptions> = {}) {
  const app = Fastify({ logger: false });
  const security = createSecurity({
    host: "127.0.0.1",
    corsOrigins: [],
    ...overrides,
  });
  await security.register(app);
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/private", async () => ({ ok: true }));
  await app.ready();
  return app;
}

test("local trusted origins can establish a protected session", async () => {
  const app = await securityApp();
  try {
    const session = await app.inject({
      method: "POST",
      url: "/api/auth/session",
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(session.statusCode, 200);
    const setCookie = headerText(session.headers["set-cookie"]);
    const cookie = setCookie.split(";", 1)[0];
    assert.ok(cookie?.startsWith("osheep_session="));
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);

    const protectedResponse = await app.inject({
      url: "/api/private",
      headers: { cookie: cookie ?? "", origin: "http://localhost:5173" },
    });
    assert.equal(protectedResponse.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("protected APIs reject missing sessions and cross-site requests", async () => {
  const app = await securityApp();
  try {
    const missingSession = await app.inject({ url: "/api/private" });
    assert.equal(missingSession.statusCode, 401);

    const crossSite = await app.inject({
      method: "POST",
      url: "/api/auth/session",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.statusCode, 403);

    const health = await app.inject({ url: "/api/health" });
    assert.equal(health.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("remote bindings require a token and explicit trusted origins", () => {
  assert.throws(() => createSecurity({ host: "0.0.0.0", corsOrigins: [] }), /OSHEEP_AUTH_TOKEN/);
  assert.throws(
    () =>
      createSecurity({
        host: "0.0.0.0",
        corsOrigins: [],
        authToken: "a-secure-test-token-with-32-characters",
      }),
    /CORS_ORIGIN/,
  );
  assert.throws(
    () =>
      createSecurity({
        host: "0.0.0.0",
        corsOrigins: ["https://osheep.example"],
        authToken: "too-short",
      }),
    /at least 32 characters/,
  );
  assert.throws(
    () =>
      createSecurity({
        host: "127.0.0.1",
        corsOrigins: ["*"],
      }),
    /cannot be '\*'/,
  );
});

test("remote sessions exchange a bearer token for a secure cookie", async () => {
  const app = await securityApp({
    host: "0.0.0.0",
    corsOrigins: ["https://osheep.example"],
    authToken: "test-remote-token-with-at-least-32-chars",
  });
  try {
    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/session",
      headers: { origin: "https://osheep.example" },
    });
    assert.equal(denied.statusCode, 401);

    const session = await app.inject({
      method: "POST",
      url: "/api/auth/session",
      headers: {
        authorization: "Bearer test-remote-token-with-at-least-32-chars",
        origin: "https://osheep.example",
      },
    });
    assert.equal(session.statusCode, 200);
    assert.match(headerText(session.headers["set-cookie"]), /; Secure$/);
  } finally {
    await app.close();
  }
});
