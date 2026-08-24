import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { migrateLegacyGlobalData } from "./global-data-migration.js";

test("legacy global templates are verified, merged, and removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-global-migrate-"));
  const legacy = path.join(root, "legacy");
  const target = path.join(root, "backend", ".osheep");
  await fs.mkdir(path.join(legacy, "templates", "user", "same"), { recursive: true });
  await fs.mkdir(path.join(legacy, "templates", "user", "conflict"), { recursive: true });
  await fs.mkdir(path.join(target, "templates", "user", "same"), { recursive: true });
  await fs.mkdir(path.join(target, "templates", "user", "conflict"), { recursive: true });
  await fs.writeFile(path.join(legacy, "templates", "user", "new.json"), "new", "utf8");
  await fs.writeFile(path.join(legacy, "templates", "user", "same", "template.json"), "same", "utf8");
  await fs.writeFile(path.join(target, "templates", "user", "same", "template.json"), "same", "utf8");
  await fs.writeFile(path.join(legacy, "templates", "user", "conflict", "template.json"), "legacy", "utf8");
  await fs.writeFile(path.join(target, "templates", "user", "conflict", "template.json"), "current", "utf8");

  const result = await migrateLegacyGlobalData({
    legacyRoot: legacy,
    targetRoot: target,
    migrationId: "test",
  });

  assert.deepEqual(result, {
    copied: 1,
    deduplicated: 1,
    conflicts: 1,
    removedLegacyRoot: true,
  });
  assert.equal(await fs.readFile(path.join(target, "templates", "user", "new.json"), "utf8"), "new");
  assert.equal(
    await fs.readFile(path.join(target, "templates", "user", "conflict", "template.json"), "utf8"),
    "current",
  );
  assert.equal(
    await fs.readFile(
      path.join(target, "migration-conflicts", "legacy-home-test", "templates", "user", "conflict", "template.json"),
      "utf8",
    ),
    "legacy",
  );
  await assert.rejects(fs.stat(legacy), { code: "ENOENT" });
});

test("legacy global migration leaves unrelated home data in place", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-global-migrate-extra-"));
  const legacy = path.join(root, "legacy");
  const target = path.join(root, "target");
  await fs.mkdir(path.join(legacy, "templates", "user"), { recursive: true });
  await fs.writeFile(path.join(legacy, "templates", "user", "template.json"), "template", "utf8");
  await fs.writeFile(path.join(legacy, "unrelated.txt"), "keep", "utf8");

  const result = await migrateLegacyGlobalData({ legacyRoot: legacy, targetRoot: target });

  assert.equal(result.removedLegacyRoot, false);
  assert.equal(await fs.readFile(path.join(legacy, "unrelated.txt"), "utf8"), "keep");
  await assert.rejects(fs.stat(path.join(legacy, "templates")), { code: "ENOENT" });
});
