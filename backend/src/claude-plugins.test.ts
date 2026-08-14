import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  addClaudeMarketplace,
  applyClaudePluginSelection,
  disableClaudePlugin,
  enableClaudePlugin,
  getClaudePluginSnapshot,
  installClaudePlugin,
  uninstallClaudePlugin,
} from "./claude-plugins.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("snapshot normalizes installed and available Claude plugins", async () => {
  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [
            {
              id: "superpowers@claude-plugins-official",
              version: "6.1.1",
              scope: "user",
              enabled: true,
              installPath: "C:/Users/me/.claude/plugins/cache/official/superpowers/6.1.1",
            },
          ],
          available: [
            {
              pluginId: "github@claude-plugins-official",
              name: "github",
              description: "GitHub workflows",
              marketplaceName: "claude-plugins-official",
              version: "1.0.0",
              installCount: 42,
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([
          {
            name: "claude-plugins-official",
            source: "github",
            repo: "anthropics/claude-plugins-official",
            installLocation: "C:/Users/me/.claude/plugins/marketplaces/official",
          },
        ]);
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const installed = snapshot.plugins.find(
    (plugin) => plugin.selector === "superpowers@claude-plugins-official",
  );
  const available = snapshot.plugins.find(
    (plugin) => plugin.selector === "github@claude-plugins-official",
  );

  assert.equal(installed?.displayName, "superpowers");
  assert.equal(installed?.version, "6.1.1");
  assert.equal(installed?.status.installed, true);
  assert.equal(installed?.status.enabled, true);
  assert.equal(
    installed?.source.path,
    "C:/Users/me/.claude/plugins/cache/official/superpowers/6.1.1",
  );
  assert.equal(available?.displayName, "github");
  assert.equal(available?.description, "GitHub workflows");
  assert.equal(available?.status.available, true);
  assert.equal(snapshot.marketplaces[0]?.name, "claude-plugins-official");
});

test("snapshot enriches installed Claude plugins with manifest icons", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-plugins-"));
  const pluginRoot = path.join(
    root,
    ".claude",
    "plugins",
    "cache",
    "claude-plugins-official",
    "superpowers",
    "6.1.1",
  );
  await writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: "superpowers",
    description: "Core skills library for Claude Code",
    version: "6.1.1",
  });
  await writeJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: "superpowers",
    version: "6.1.1",
    description: "Planning workflows",
    interface: {
      displayName: "Superpowers",
      shortDescription: "Planning, TDD, and debugging workflows",
      composerIcon: "./assets/superpowers-small.svg",
      brandColor: "#F59E0B",
    },
  });
  await fs.mkdir(path.join(pluginRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "assets", "superpowers-small.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
    "utf8",
  );

  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [
            {
              id: "superpowers@claude-plugins-official",
              version: "6.1.1",
              enabled: true,
              installPath: pluginRoot,
            },
          ],
          available: [],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return "[]";
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const installed = snapshot.plugins.find(
    (plugin) => plugin.selector === "superpowers@claude-plugins-official",
  ) as
    | {
        displayName?: string;
        description?: string;
        icon?: string;
        iconColor?: string;
      }
    | undefined;

  assert.equal(installed?.displayName, "Superpowers");
  assert.equal(installed?.description, "Planning, TDD, and debugging workflows");
  assert.match(installed?.icon ?? "", /^data:image\/svg\+xml;base64,/);
  assert.equal(installed?.iconColor, "#F59E0B");
});

test("snapshot restores an installed plugin icon from marketplace metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-plugins-"));
  const marketplaceRoot = path.join(root, ".claude", "plugins", "marketplaces", "official");
  const pluginRoot = path.join(marketplaceRoot, "plugins", "superpowers");
  const missingInstallPath = path.join(root, "unreadable-installed-cache");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    plugins: [{ name: "superpowers", source: "./plugins/superpowers" }],
  });
  await writeJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: "superpowers",
    interface: {
      displayName: "Superpowers",
      composerIcon: "./assets/superpowers.svg",
      brandColor: "#F59E0B",
    },
  });
  await fs.mkdir(path.join(pluginRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "assets", "superpowers.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
    "utf8",
  );

  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [
            {
              id: "superpowers@claude-plugins-official",
              version: "6.3.0",
              enabled: true,
              installPath: missingInstallPath,
            },
          ],
          available: [],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([
          {
            name: "claude-plugins-official",
            installLocation: marketplaceRoot,
          },
        ]);
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const installed = snapshot.plugins.find(
    (plugin) => plugin.selector === "superpowers@claude-plugins-official",
  );
  assert.equal(installed?.displayName, "Superpowers");
  assert.match(installed?.icon ?? "", /^data:image\/svg\+xml;base64,/);
  assert.equal(installed?.iconColor, "#F59E0B");
  assert.equal(installed?.source.path, missingInstallPath);
  assert.equal(installed?.status.available, false);
});

test("snapshot exposes marketplace plugins missing from Claude available output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-plugins-"));
  const marketplaceRoot = path.join(root, ".claude", "plugins", "marketplaces", "official");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    plugins: [
      {
        name: "official-only",
        source: "./plugins/official-only",
        homepage: "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/official-only",
      },
    ],
  });

  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({ installed: [], available: [] });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([
          { name: "claude-plugins-official", installLocation: marketplaceRoot },
        ]);
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const plugin = snapshot.plugins.find((item) => item.selector === "official-only@claude-plugins-official");
  assert.equal(plugin?.status.available, true);
  assert.equal(plugin?.status.installed, false);
  assert.equal(plugin?.icon, "https://github.com/anthropics.png?size=64");
});

test("snapshot keeps installed manifest metadata when plugin is also available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-plugins-"));
  const pluginRoot = path.join(
    root,
    ".claude",
    "plugins",
    "cache",
    "claude-plugins-official",
    "superpowers",
    "6.1.1",
  );
  await writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: "superpowers",
    description: "Claude marketplace description",
    version: "6.1.1",
  });
  await writeJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: "superpowers",
    version: "6.1.1",
    interface: {
      displayName: "Superpowers",
      shortDescription: "Planning, TDD, and debugging workflows",
      composerIcon: "./assets/superpowers-small.svg",
      brandColor: "#F59E0B",
    },
  });
  await fs.mkdir(path.join(pluginRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "assets", "superpowers-small.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
    "utf8",
  );

  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [
            {
              id: "superpowers@claude-plugins-official",
              version: "6.1.1",
              enabled: true,
              installPath: pluginRoot,
            },
          ],
          available: [
            {
              pluginId: "superpowers@claude-plugins-official",
              name: "superpowers",
              description: "Available list description",
              marketplaceName: "claude-plugins-official",
              version: "6.1.1",
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return "[]";
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const installed = snapshot.plugins.find(
    (plugin) => plugin.selector === "superpowers@claude-plugins-official",
  ) as
    | {
        displayName?: string;
        description?: string;
        icon?: string;
        iconColor?: string;
        status?: { available?: boolean; installed?: boolean };
      }
    | undefined;

  assert.equal(installed?.displayName, "Superpowers");
  assert.equal(installed?.description, "Planning, TDD, and debugging workflows");
  assert.match(installed?.icon ?? "", /^data:image\/svg\+xml;base64,/);
  assert.equal(installed?.iconColor, "#F59E0B");
  assert.equal(installed?.status?.available, true);
  assert.equal(installed?.status?.installed, true);
});

test("snapshot enriches available Claude plugins from marketplace manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-plugins-"));
  const marketplaceRoot = path.join(
    root,
    ".claude",
    "plugins",
    "marketplaces",
    "claude-plugins-official",
  );
  const pluginRoot = path.join(marketplaceRoot, "plugins", "github");
  await writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: "github",
    description: "Official GitHub MCP server",
  });
  await writeJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: "github",
    interface: {
      displayName: "GitHub",
      shortDescription: "Repository and pull request workflows",
      composerIcon: "./assets/github.svg",
      brandColor: "#24292F",
    },
  });
  await fs.mkdir(path.join(pluginRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "assets", "github.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
    "utf8",
  );

  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [],
          available: [
            {
              pluginId: "github@claude-plugins-official",
              name: "github",
              description: "Available list description",
              marketplaceName: "claude-plugins-official",
              source: "./plugins/github",
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([
          {
            name: "claude-plugins-official",
            installLocation: marketplaceRoot,
          },
        ]);
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const available = snapshot.plugins.find(
    (plugin) => plugin.selector === "github@claude-plugins-official",
  ) as
    | {
        displayName?: string;
        description?: string;
        icon?: string;
        iconColor?: string;
      }
    | undefined;

  assert.equal(available?.displayName, "GitHub");
  assert.equal(available?.description, "Repository and pull request workflows");
  assert.match(available?.icon ?? "", /^data:image\/svg\+xml;base64,/);
  assert.equal(available?.iconColor, "#24292F");
});

test("snapshot gives available Claude plugins an icon fallback", async () => {
  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [],
          available: [
            {
              pluginId: "airtable@claude-plugins-official",
              name: "airtable",
              description: "Airtable workflows",
              marketplaceName: "claude-plugins-official",
              source: "./plugins/airtable",
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([
          {
            name: "claude-plugins-official",
            installLocation: "C:/Users/me/.claude/plugins/marketplaces/official",
          },
        ]);
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const available = snapshot.plugins.find(
    (plugin) => plugin.selector === "airtable@claude-plugins-official",
  );

  assert.match(available?.icon ?? "", /^data:image\/svg\+xml,/);
});

test("snapshot derives available Claude plugin icons from GitHub source URLs", async () => {
  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [],
          available: [
            {
              pluginId: "42crunch-api-security-testing@claude-plugins-official",
              name: "42crunch-api-security-testing",
              description: "API security workflows",
              marketplaceName: "claude-plugins-official",
              source: {
                source: "git-subdir",
                url: "https://github.com/42Crunch-AI/claude-plugins.git",
                path: "plugins/api-security-testing",
              },
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return "[]";
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const available = snapshot.plugins.find(
    (plugin) => plugin.selector === "42crunch-api-security-testing@claude-plugins-official",
  );

  assert.equal(available?.icon, "https://github.com/42Crunch-AI.png?size=64");
});

test("snapshot derives local available Claude plugin icons from marketplace homepage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-plugins-"));
  const marketplaceRoot = path.join(
    root,
    ".claude",
    "plugins",
    "marketplaces",
    "claude-plugins-official",
  );
  const pluginRoot = path.join(marketplaceRoot, "plugins", "agent-sdk-dev");
  await writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: "agent-sdk-dev",
    description: "Claude Agent SDK Development Plugin",
    author: {
      name: "Anthropic",
    },
  });
  await writeJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    name: "claude-plugins-official",
    plugins: [
      {
        name: "agent-sdk-dev",
        source: "./plugins/agent-sdk-dev",
        homepage:
          "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/agent-sdk-dev",
      },
    ],
  });

  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [],
          available: [
            {
              pluginId: "agent-sdk-dev@claude-plugins-official",
              name: "agent-sdk-dev",
              description: "Development kit for working with the Claude Agent SDK",
              marketplaceName: "claude-plugins-official",
              source: "./plugins/agent-sdk-dev",
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([
          {
            name: "claude-plugins-official",
            installLocation: marketplaceRoot,
          },
        ]);
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const available = snapshot.plugins.find(
    (plugin) => plugin.selector === "agent-sdk-dev@claude-plugins-official",
  );

  assert.equal(available?.icon, "https://github.com/anthropics.png?size=64");
});

test("snapshot prefers local manifest author icons over marketplace homepage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-plugins-"));
  const marketplaceRoot = path.join(
    root,
    ".claude",
    "plugins",
    "marketplaces",
    "claude-plugins-official",
  );
  const pluginRoot = path.join(marketplaceRoot, "external_plugins", "github");
  await writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: "github",
    description: "Official GitHub MCP server",
    author: {
      name: "GitHub",
    },
  });
  await writeJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    name: "claude-plugins-official",
    plugins: [
      {
        name: "github",
        source: "./external_plugins/github",
        homepage:
          "https://github.com/anthropics/claude-plugins-public/tree/main/external_plugins/github",
      },
    ],
  });

  const snapshot = await getClaudePluginSnapshot({
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [],
          available: [
            {
              pluginId: "github@claude-plugins-official",
              name: "github",
              description: "Official GitHub MCP server",
              marketplaceName: "claude-plugins-official",
              source: "./external_plugins/github",
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([
          {
            name: "claude-plugins-official",
            installLocation: marketplaceRoot,
          },
        ]);
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const available = snapshot.plugins.find(
    (plugin) => plugin.selector === "github@claude-plugins-official",
  );

  assert.equal(available?.icon, "https://github.com/github.png?size=64");
});

test("Claude plugin actions call the expected CLI commands", async () => {
  const calls: string[][] = [];
  const runCli = async (args: string[]) => {
    calls.push(args);
    return "{}";
  };

  await installClaudePlugin("github@claude-plugins-official", { runCli });
  await enableClaudePlugin("github@claude-plugins-official", { runCli });
  await disableClaudePlugin("github@claude-plugins-official", { runCli });
  await uninstallClaudePlugin("github@claude-plugins-official", { runCli });
  await addClaudeMarketplace("anthropics/claude-plugins-official", { runCli });

  assert.deepEqual(calls, [
    ["plugin", "install", "github@claude-plugins-official"],
    ["plugin", "enable", "github@claude-plugins-official"],
    ["plugin", "disable", "github@claude-plugins-official"],
    ["plugin", "uninstall", "github@claude-plugins-official", "--yes"],
    ["plugin", "marketplace", "add", "anthropics/claude-plugins-official"],
  ]);
});

test("Claude plugin actions reject unsafe selectors before invoking the CLI", async () => {
  let calls = 0;
  const runCli = async () => {
    calls += 1;
    return "{}";
  };

  await assert.rejects(
    () => enableClaudePlugin("github@official & whoami", { runCli }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_QUERY",
  );

  assert.equal(calls, 0);
});

test("workflow Claude plugin selection only toggles installed plugins", async () => {
  const calls: string[][] = [];
  const enabled = new Set(["alpha@official", "beta@official"]);
  const runCli = async (args: string[]) => {
    calls.push(args);
    if (args.join(" ") === "plugin list --available --json") {
      return JSON.stringify({
        installed: [
          { id: "alpha@official", enabled: enabled.has("alpha@official") },
          { id: "beta@official", enabled: enabled.has("beta@official") },
        ],
        available: [{ pluginId: "not-installed@official" }],
      });
    }
    if (args.join(" ") === "plugin marketplace list --json") return "[]";
    if (args[0] === "plugin" && args[1] === "disable") enabled.delete(args[2]!);
    if (args[0] === "plugin" && args[1] === "enable") enabled.add(args[2]!);
    return "{}";
  };

  const snapshot = await applyClaudePluginSelection(["alpha@official"], { runCli });
  assert.equal(
    snapshot.plugins.find((plugin) => plugin.selector === "alpha@official")?.status.enabled,
    true,
  );
  assert.equal(
    snapshot.plugins.find((plugin) => plugin.selector === "beta@official")?.status.enabled,
    false,
  );
  assert.deepEqual(
    calls.filter((args) => args[0] === "plugin" && (args[1] === "enable" || args[1] === "disable")),
    [["plugin", "disable", "beta@official"]],
  );
  assert.equal(
    calls.some((args) => args[2] === "not-installed@official"),
    false,
  );
});
