import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  type AiProvider,
  type AiSettingsState,
  readAiSettings,
  snapshotAiSettings,
  switchAiProvider,
  writeAiSettings,
} from "./ai-settings.js";

const ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OSHEEP_CLAUDE_CONFIG_DIR",
  "OSHEEP_CODEX_CONFIG_DIR",
  "OSHEEP_AI_SETTINGS_STORE_PATH",
] as const;

function provider(id: string, settingsConfig: unknown, category = "custom"): AiProvider {
  return { id, name: id, category, settingsConfig };
}

function stateWith(
  app: "claude" | "codex",
  providers: AiProvider[],
  current: string,
): AiSettingsState {
  return {
    version: 1,
    apps: {
      claude: { providers: {}, current: "" },
      codex: { providers: {}, current: "" },
      [app]: {
        providers: Object.fromEntries(providers.map((item) => [item.id, item])),
        current,
      },
    },
  };
}

test("switches Claude and Codex live configuration using cc-switch semantics", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-ai-settings-"));
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.OSHEEP_AI_SETTINGS_STORE_PATH = path.join(root, "store", "ai-settings.json");
  delete process.env.OSHEEP_CLAUDE_CONFIG_DIR;
  delete process.env.OSHEEP_CODEX_CONFIG_DIR;

  t.after(async () => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  await t.test("uses Claude's existing legacy filename and sanitizes internal fields", async () => {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR as string;
    const legacyPath = path.join(claudeDir, "claude.json");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(legacyPath, '{"env":{"ANTHROPIC_MODEL":"old-live"}}\n', "utf8");

    const oldProvider = provider("old", { env: { ANTHROPIC_MODEL: "old-stored" } });
    const nextProvider = provider("next", {
      api_format: "internal",
      env: {
        ANTHROPIC_BASE_URL: "https://example.test",
        ANTHROPIC_MODEL: "next-model",
        ANTHROPIC_SMALL_FAST_MODEL: "keep-as-saved",
      },
    });
    await writeAiSettings(stateWith("claude", [oldProvider, nextProvider], "old"));

    const snapshot = await switchAiProvider("claude", "next");
    const live = JSON.parse(await fs.readFile(legacyPath, "utf8")) as Record<string, unknown>;

    assert.equal(snapshot.paths.claude.settings, legacyPath);
    assert.equal(snapshot.state.apps.claude.current, "next");
    assert.equal(live.api_format, undefined);
    assert.deepEqual(live.env, {
      ANTHROPIC_BASE_URL: "https://example.test",
      ANTHROPIC_MODEL: "next-model",
      ANTHROPIC_SMALL_FAST_MODEL: "keep-as-saved",
    });
    assert.equal(
      (
        snapshot.state.apps.claude.providers.old.settingsConfig as {
          env: { ANTHROPIC_MODEL: string };
        }
      ).env.ANTHROPIC_MODEL,
      "old-live",
    );
  });

  await t.test("switches both Codex auth.json and config.toml", async () => {
    const codexDir = process.env.CODEX_HOME as string;
    const authPath = path.join(codexDir, "auth.json");
    const configPath = path.join(codexDir, "config.toml");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(authPath, '{"OPENAI_API_KEY":"live-old"}\n', "utf8");
    await fs.writeFile(configPath, 'model = "live-old"\n', "utf8");

    const oldProvider = provider("old", {
      auth: { OPENAI_API_KEY: "stored-old" },
      config: 'model = "stored-old"\n',
    });
    const nextProvider = provider("next", {
      auth: { OPENAI_API_KEY: "next-key", auth_mode: "apikey" },
      config:
        'model = "next-model"\nmodel_provider = "custom"\n\n[model_providers.custom]\nbase_url = "https://example.test/v1"\nwire_api = "responses"\n',
    });
    await writeAiSettings(stateWith("codex", [oldProvider, nextProvider], "old"));

    const snapshot = await switchAiProvider("codex", "next");
    const liveAuth = JSON.parse(await fs.readFile(authPath, "utf8"));
    const liveConfig = await fs.readFile(configPath, "utf8");

    assert.equal(snapshot.state.apps.codex.current, "next");
    assert.deepEqual(liveAuth, { OPENAI_API_KEY: "next-key", auth_mode: "apikey" });
    assert.equal(liveConfig, (nextProvider.settingsConfig as { config: string }).config);
    assert.deepEqual(snapshot.state.apps.codex.providers.old.settingsConfig, {
      auth: { OPENAI_API_KEY: "live-old" },
      config: 'model = "live-old"\n',
    });
  });

  await t.test(
    "does not change live files or current provider for invalid target TOML",
    async () => {
      const codexDir = process.env.CODEX_HOME as string;
      const authPath = path.join(codexDir, "auth.json");
      const configPath = path.join(codexDir, "config.toml");
      const liveAuth = '{"OPENAI_API_KEY":"unchanged"}\n';
      const liveConfig = 'model = "unchanged"\n';
      await fs.writeFile(authPath, liveAuth, "utf8");
      await fs.writeFile(configPath, liveConfig, "utf8");

      const current = provider("current", {
        auth: { OPENAI_API_KEY: "unchanged" },
        config: liveConfig,
      });
      const invalid = provider("invalid", {
        auth: { OPENAI_API_KEY: "bad" },
        config: 'model = "unterminated',
      });
      await writeAiSettings(stateWith("codex", [current, invalid], "current"));

      await assert.rejects(() => switchAiProvider("codex", "invalid"), /config\.toml is invalid/);
      assert.equal((await readAiSettings()).apps.codex.current, "current");
      assert.equal(await fs.readFile(authPath, "utf8"), liveAuth);
      assert.equal(await fs.readFile(configPath, "utf8"), liveConfig);
    },
  );

  await t.test("reports the standard CLI configuration directories", async () => {
    const snapshot = await snapshotAiSettings();
    assert.equal(snapshot.paths.claude.dir, process.env.CLAUDE_CONFIG_DIR);
    assert.equal(snapshot.paths.codex.dir, process.env.CODEX_HOME);
  });
});
