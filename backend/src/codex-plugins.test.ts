import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  addCodexMarketplace,
  createLocalCodexPlugin,
  getCodexPluginSnapshot,
  importLocalCodexPlugin,
  installCodexPlugin,
  normalizePluginName,
  parseCliJson,
  removeLocalCodexPlugin,
  toWindowsCmdCommandLine,
  toMarketplaceSourcePath,
  uninstallCodexPlugin,
  type CodexPluginPaths,
} from "./codex-plugins.js";

const execFileAsync = promisify(execFile);

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

test("toWindowsCmdCommandLine quotes arguments with spaces", () => {
  assert.equal(
    toWindowsCmdCommandLine("codex.cmd", [
      "plugin",
      "marketplace",
      "add",
      "C:/Users/Jane Doe/plugins/debug",
      "--json",
    ]),
    'call "codex.cmd" "plugin" "marketplace" "add" "C:/Users/Jane Doe/plugins/debug" "--json"'
  );
});

test("toWindowsCmdCommandLine rejects unsafe shell metacharacters", () => {
  assert.throws(
    () => toWindowsCmdCommandLine("codex.cmd", ["plugin", "add", "sample@debug & whoami"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUERY"
  );
});

test("toWindowsCmdCommandLine runs cmd files with arguments containing spaces", async () => {
  if (process.platform !== "win32") return;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-cmd-args-"));
  const script = path.join(root, "arg dump.cmd");
  await fs.writeFile(script, "@echo off\r\necho source=%~1\r\n", "utf8");

  const result = await execFileAsync(
    "cmd.exe",
    [
      "/d",
      "/s",
      "/c",
      toWindowsCmdCommandLine(script, ["C:/Users/Jane Doe/plugins/debug"]),
    ],
    { encoding: "utf8", windowsVerbatimArguments: true }
  );

  assert.match(result.stdout, /source=C:\/Users\/Jane Doe\/plugins\/debug/);
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

test("createLocalCodexPlugin rejects malformed personal marketplace files", async () => {
  const paths = await makeFixturePaths();
  await fs.mkdir(path.dirname(paths.personalMarketplace), { recursive: true });
  await fs.writeFile(paths.personalMarketplace, "{ bad json", "utf8");

  await assert.rejects(
    () =>
      createLocalCodexPlugin(
        { name: "broken-marketplace", displayName: "Broken Marketplace" },
        { paths, runCli: async () => "{}" }
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUERY"
  );

  const text = await fs.readFile(paths.personalMarketplace, "utf8");
  assert.equal(text, "{ bad json");
});

test("createLocalCodexPlugin rejects personal marketplace files with invalid plugins shape", async () => {
  const paths = await makeFixturePaths();
  await writeJson(paths.personalMarketplace, {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: {},
  });

  await assert.rejects(
    () =>
      createLocalCodexPlugin(
        { name: "broken-shape", displayName: "Broken Shape" },
        { paths, runCli: async () => "{}" }
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUERY"
  );

  const marketplace = JSON.parse(await fs.readFile(paths.personalMarketplace, "utf8")) as {
    plugins: unknown;
  };
  assert.deepEqual(marketplace.plugins, {});
});

test("createLocalCodexPlugin refuses to overwrite an existing plugin manifest", async () => {
  const paths = await makeFixturePaths();
  const manifestPath = path.join(
    paths.personalPluginRoot,
    "my-tools",
    ".codex-plugin",
    "plugin.json"
  );
  await writeJson(manifestPath, {
    name: "my-tools",
    interface: { displayName: "Original" },
  });

  await assert.rejects(
    () =>
      createLocalCodexPlugin(
        { name: "My Tools", displayName: "Replacement" },
        { paths, runCli: async () => "{}" }
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ENTRY_EXISTS"
  );

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    interface?: { displayName?: string };
  };
  assert.equal(manifest.interface?.displayName, "Original");
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

test("toMarketplaceSourcePath keeps absolute paths for different-drive imports", () => {
  if (process.platform !== "win32") return;
  const marketplacePath = String.raw`D:\users\me\.agents\plugins\marketplace.json`;
  const pluginRoot = String.raw`E:\plugins\imported`;
  assert.equal(
    toMarketplaceSourcePath(marketplacePath, pluginRoot),
    "E:/plugins/imported"
  );
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

test("removeLocalCodexPlugin does not delete an untracked personal plugin directory", async () => {
  const paths = await makeFixturePaths();
  const pluginRoot = path.join(paths.personalPluginRoot, "orphaned-plugin");
  await writeJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: "orphaned-plugin",
  });

  await assert.rejects(
    () =>
      removeLocalCodexPlugin("orphaned-plugin", true, {
        paths,
        runCli: async () => "{}",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "NOT_FOUND"
  );

  await fs.access(pluginRoot);
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

test("addCodexMarketplace preserves marketplace sources containing spaces", async () => {
  const calls: string[][] = [];
  const runCli = async (args: string[]) => {
    calls.push(args);
    return '{"ok":true}';
  };

  await addCodexMarketplace("C:/Users/Jane Doe/plugins/debug", { runCli });

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "add", "C:/Users/Jane Doe/plugins/debug", "--json"],
  ]);
});

test("install and uninstall reject unsafe plugin selectors before invoking Codex CLI", async () => {
  let calls = 0;
  const runCli = async () => {
    calls += 1;
    return '{"ok":true}';
  };

  await assert.rejects(
    () => installCodexPlugin("sample@debug & whoami", { runCli }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUERY"
  );
  await assert.rejects(
    () => uninstallCodexPlugin("sample@debug | whoami", { runCli }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUERY"
  );

  assert.equal(calls, 0);
});

test("addCodexMarketplace rejects unsafe source strings before invoking Codex CLI", async () => {
  let calls = 0;
  const runCli = async () => {
    calls += 1;
    return '{"ok":true}';
  };

  await assert.rejects(
    () => addCodexMarketplace('C:/plugins/debug & echo "oops"', { runCli }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUERY"
  );

  assert.equal(calls, 0);
});
