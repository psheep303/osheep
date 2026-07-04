import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  addCodexMarketplace,
  createLocalCodexPlugin,
  getCodexPluginSnapshot,
  importLocalCodexPlugin,
  installCodexPlugin,
  normalizePluginName,
  parseCliJson,
  removeLocalCodexPlugin,
  uninstallCodexPlugin,
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

async function noCli(): Promise<string> {
  return JSON.stringify({ installed: [], available: [], marketplaces: [] });
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
  assert.equal(localTools?.source.path, path.join(paths.personalPluginRoot, "local-tools"));
  assert.equal(snapshot.marketplaces[0]?.name, "debug");
});

test("personal marketplace ./plugins paths resolve under the personal plugin root", async () => {
  const paths = await makeFixturePaths();
  await writeJson(paths.personalMarketplace, {
    name: "personal",
    plugins: [
      {
        name: "local-tools",
        source: { source: "local", path: "./plugins/local-tools" },
      },
    ],
  });
  await writeJson(
    path.join(paths.personalPluginRoot, "local-tools", ".codex-plugin", "plugin.json"),
    {
      name: "local-tools",
      interface: { displayName: "Local Tools" },
    }
  );

  const snapshot = await getCodexPluginSnapshot({ paths, runCli: noCli });
  const localTools = snapshot.plugins.find((p) => p.selector === "local-tools@personal");

  assert.equal(localTools?.source.path, path.join(paths.personalPluginRoot, "local-tools"));
});

test("personal marketplace non-plugin relative paths resolve from the marketplace file", async () => {
  const paths = await makeFixturePaths();
  await writeJson(paths.personalMarketplace, {
    name: "personal",
    plugins: [
      {
        name: "sibling-tools",
        source: { source: "local", path: "../shared/sibling-tools" },
      },
    ],
  });
  const pluginPath = path.resolve(path.dirname(paths.personalMarketplace), "../shared/sibling-tools");
  await writeJson(path.join(pluginPath, ".codex-plugin", "plugin.json"), {
    name: "sibling-tools",
    interface: { displayName: "Sibling Tools" },
  });

  const snapshot = await getCodexPluginSnapshot({ paths, runCli: noCli });
  const siblingTools = snapshot.plugins.find((p) => p.selector === "sibling-tools@personal");

  assert.equal(siblingTools?.displayName, "Sibling Tools");
  assert.equal(siblingTools?.source.path, pluginPath);
});

test("malformed personal marketplace JSON adds a warning", async () => {
  const paths = await makeFixturePaths();
  await fs.mkdir(path.dirname(paths.personalMarketplace), { recursive: true });
  await fs.writeFile(paths.personalMarketplace, "{ not json", "utf8");

  const snapshot = await getCodexPluginSnapshot({ paths, runCli: noCli });

  assert.match(snapshot.warnings.join("\n"), /Personal marketplace parse failed:/);
  assert.match(snapshot.warnings.join("\n"), new RegExp(paths.personalMarketplace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("createLocalCodexPlugin writes manifest and initial personal marketplace", async () => {
  const paths = await makeFixturePaths();
  await createLocalCodexPlugin(
    { name: "My Tools", displayName: "My Tools", description: "Useful local commands" },
    { paths, runCli: async () => "{}" }
  );
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(paths.personalPluginRoot, "my-tools", ".codex-plugin", "plugin.json"),
      "utf8"
    )
  ) as { name: string; interface: { displayName: string } };
  assert.equal(manifest.name, "my-tools");
  assert.equal(manifest.interface.displayName, "My Tools");
  const marketplace = JSON.parse(await fs.readFile(paths.personalMarketplace, "utf8")) as {
    name: string;
    plugins: Array<{ name: string; source: { path: string } }>;
  };
  assert.equal(marketplace.name, "personal");
  assert.equal(marketplace.plugins[0]?.name, "my-tools");
  assert.equal(marketplace.plugins[0]?.source.path, "./plugins/my-tools");
});

test("importLocalCodexPlugin adds existing manifest to personal marketplace", async () => {
  const paths = await makeFixturePaths();
  const pluginPath = path.join(paths.personalPluginRoot, "imported");
  await writeJson(path.join(pluginPath, ".codex-plugin", "plugin.json"), {
    name: "imported",
    version: "1.2.3",
    description: "Imported plugin",
    interface: { displayName: "Imported" },
  });
  await importLocalCodexPlugin({ path: pluginPath }, { paths, runCli: async () => "{}" });
  const snapshot = await getCodexPluginSnapshot({ paths, runCli: async () => '{"installed":[],"available":[]}' });
  assert.equal(snapshot.plugins[0]?.selector, "imported@personal");
  assert.equal(snapshot.plugins[0]?.displayName, "Imported");
});

test("removeLocalCodexPlugin refuses to delete source outside the personal plugin root", async () => {
  const paths = await makeFixturePaths();
  const outside = path.join(path.dirname(paths.personalPluginRoot), "outside-plugin");
  await writeJson(path.join(outside, ".codex-plugin", "plugin.json"), { name: "outside-plugin" });
  await fs.mkdir(path.dirname(paths.personalMarketplace), { recursive: true });
  await fs.writeFile(
    paths.personalMarketplace,
    JSON.stringify({
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [
        {
          name: "outside-plugin",
          source: { source: "local", path: "../outside-plugin" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }),
    "utf8"
  );
  await assert.rejects(
    () => removeLocalCodexPlugin("outside-plugin", true, { paths, runCli: async () => "{}" }),
    /Refusing to delete source outside personal plugin root/
  );
});

test("install, uninstall, and marketplace add call Codex CLI with JSON flags", async () => {
  const calls: string[][] = [];
  const runCli = async (args: string[]) => {
    calls.push(args);
    return '{"ok":true}';
  };
  await installCodexPlugin("sample@debug", { runCli });
  await uninstallCodexPlugin("sample@debug", { runCli });
  await addCodexMarketplace("C:/plugins/debug", { runCli });
  assert.deepEqual(calls, [
    ["plugin", "add", "sample@debug", "--json"],
    ["plugin", "remove", "sample@debug", "--json"],
    ["plugin", "marketplace", "add", "C:/plugins/debug", "--json"],
  ]);
});
