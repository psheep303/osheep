import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
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
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
