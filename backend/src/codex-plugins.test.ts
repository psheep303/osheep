import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  getCodexPluginSnapshot,
  normalizePluginName,
  parseCliJson,
  type CodexPluginPaths,
} from "./codex-plugins.js";

test("normalizePluginName creates lower-case kebab-case names", () => {
  assert.equal(normalizePluginName(" My Super_Plugin!! "), "my-super-plugin");
  assert.equal(normalizePluginName("A".repeat(80)), "a".repeat(64));
});

test("normalizePluginName falls back to plugin for empty input", () => {
  assert.equal(normalizePluginName("!!!"), "plugin");
});

test("parseCliJson skips Windows code-page banner before JSON", () => {
  const parsed = parseCliJson('Active code page: 65001\n{"installed":[],"available":[]}');
  assert.deepEqual(parsed, { installed: [], available: [] });
});

test("parseCliJson reports a useful error when stdout has no JSON", () => {
  assert.throws(
    () => parseCliJson("Active code page: 65001\nnot json"),
    /Codex CLI did not return JSON/
  );
});

async function makeFixturePaths(): Promise<CodexPluginPaths> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-plugins-"));
  return {
    codexDir: path.join(root, ".codex"),
    codexConfig: path.join(root, ".codex", "config.toml"),
    codexPluginCache: path.join(root, ".codex", "plugins", "cache"),
    personalMarketplace: path.join(root, ".agents", "plugins", "marketplace.json"),
    personalPluginRoot: path.join(root, "plugins"),
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("snapshot merges CLI, config, cache, and personal marketplace records", async () => {
  const paths = await makeFixturePaths();
  await fs.mkdir(path.dirname(paths.codexConfig), { recursive: true });
  await fs.writeFile(
    paths.codexConfig,
    '[plugins."superpowers@openai-api-curated"]\nenabled = true\n',
    "utf8"
  );
  await writeJson(
    path.join(
      paths.codexPluginCache,
      "openai-api-curated",
      "superpowers",
      "3fdeeb49",
      ".codex-plugin",
      "plugin.json"
    ),
    {
      name: "superpowers",
      version: "5.1.3",
      description: "Planning workflows",
      interface: { displayName: "Superpowers" },
    }
  );
  await writeJson(paths.personalMarketplace, {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: [
      {
        name: "local-tools",
        source: { source: "local", path: "./plugins/local-tools" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  await writeJson(
    path.join(paths.personalPluginRoot, "local-tools", ".codex-plugin", "plugin.json"),
    {
      name: "local-tools",
      version: "0.1.0",
      description: "Local helper plugin",
      interface: { displayName: "Local Tools" },
    }
  );

  const snapshot = await getCodexPluginSnapshot({
    paths,
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [],
          available: [
            {
              name: "sample",
              marketplace: "debug",
              version: "1.0.0",
              description: "Sample plugin",
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify({
          marketplaces: [{ name: "debug", source: "local", path: "C:/debug" }],
        });
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const selectors = snapshot.plugins.map((p) => p.selector).sort();
  assert.deepEqual(selectors, [
    "local-tools@personal",
    "sample@debug",
    "superpowers@openai-api-curated",
  ]);
  const superpowers = snapshot.plugins.find((p) => p.selector === "superpowers@openai-api-curated");
  assert.equal(superpowers?.displayName, "Superpowers");
  assert.equal(superpowers?.status.enabled, true);
  assert.equal(superpowers?.status.cached, true);
  assert.equal(superpowers?.status.installed, true);
  const localTools = snapshot.plugins.find((p) => p.selector === "local-tools@personal");
  assert.equal(localTools?.displayName, "Local Tools");
  assert.equal(localTools?.version, "0.1.0");
  assert.equal(localTools?.description, "Local helper plugin");
  assert.equal(localTools?.status.local, true);
  assert.equal(localTools?.status.available, true);
  assert.equal(snapshot.marketplaces[0]?.name, "debug");
});
