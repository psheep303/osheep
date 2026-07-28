import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import Fastify from "fastify";
import { registerStaticSite } from "./static-site.js";

test("static site serves assets, SPA routes, and preserves API 404s", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osheep-static-"));
  const app = Fastify();
  try {
    await writeFile(path.join(root, "index.html"), "<main>osheep</main>");
    await writeFile(path.join(root, "app.js"), "export {};");
    await registerStaticSite(app, root);

    const asset = await app.inject({ method: "GET", url: "/app.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers["content-type"] ?? "", /^text\/javascript/);

    const route = await app.inject({ method: "GET", url: "/workspaces/demo" });
    assert.equal(route.statusCode, 200);
    assert.equal(route.body, "<main>osheep</main>");

    const apiMiss = await app.inject({ method: "GET", url: "/api/missing" });
    assert.equal(apiMiss.statusCode, 404);
    assert.equal(apiMiss.json().error.code, "NOT_FOUND");

    const assetMiss = await app.inject({ method: "GET", url: "/missing.js" });
    assert.equal(assetMiss.statusCode, 404);

    const traversal = await app.inject({
      method: "GET",
      url: "/%2e%2e/outside.txt",
    });
    assert.equal(traversal.statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("assets get immutable cache header", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osheep-static-"));
  const app = Fastify();
  try {
    await writeFile(path.join(root, "index.html"), "<main>osheep</main>");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "app.js"), "export {};");
    await registerStaticSite(app, root);

    const response = await app.inject({ url: "/assets/app.js" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("index.html supports etag revalidation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osheep-static-"));
  const app = Fastify();
  try {
    await writeFile(path.join(root, "index.html"), "<main>osheep</main>");
    await registerStaticSite(app, root);

    const first = await app.inject({ url: "/" });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["cache-control"], "no-cache");
    const etag = first.headers.etag;
    assert.ok(etag);

    const second = await app.inject({
      url: "/",
      headers: { "if-none-match": etag },
    });

    assert.equal(second.statusCode, 304);
    assert.equal(second.body, "");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("serves precompressed gzip when available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osheep-static-"));
  const app = Fastify();
  const source = "console.log('compressed');";
  try {
    await writeFile(path.join(root, "index.html"), "<main>osheep</main>");
    await mkdir(path.join(root, "assets"));
    const assetPath = path.join(root, "assets", "app.js");
    await writeFile(assetPath, source);
    await writeFile(`${assetPath}.gz`, gzipSync(source));
    await registerStaticSite(app, root);

    const compressed = await app.inject({
      url: "/assets/app.js",
      headers: { "accept-encoding": "gzip, br" },
    });

    assert.equal(compressed.statusCode, 200);
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.equal(compressed.headers.vary, "accept-encoding");
    assert.match(compressed.headers["content-type"] ?? "", /^text\/javascript/);
    assert.equal(gunzipSync(compressed.rawPayload).toString(), source);

    const identity = await app.inject({
      url: "/assets/app.js",
      headers: { "accept-encoding": "gzip;q=0, br" },
    });

    assert.equal(identity.headers["content-encoding"], undefined);
    assert.equal(identity.headers.vary, "accept-encoding");
    assert.equal(identity.body, source);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
