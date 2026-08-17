import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  getClaudeOnboardingStatus,
  resolveClaudeOnboardingPath,
  setClaudeOnboardingSkip,
} from "./claude-onboarding.js";

test("Claude onboarding path follows the active Claude config directory", () => {
  const customDirectory = path.join(os.tmpdir(), "claude-work");
  assert.equal(
    resolveClaudeOnboardingPath({}, os.tmpdir()),
    path.join(os.tmpdir(), ".claude.json"),
  );
  assert.equal(
    resolveClaudeOnboardingPath({ CLAUDE_CONFIG_DIR: customDirectory }, os.tmpdir()),
    path.join(path.dirname(customDirectory), "claude-work.json"),
  );
});

test("Claude onboarding toggle preserves unrelated configuration", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-onboarding-"));
  const configPath = path.join(directory, ".claude.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.deepEqual(await getClaudeOnboardingStatus(configPath), {
    enabled: false,
    path: configPath,
  });

  await fs.writeFile(configPath, `${JSON.stringify({ theme: "dark", count: 2 })}\n`, "utf8");
  assert.equal((await setClaudeOnboardingSkip(true, configPath)).enabled, true);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
    theme: "dark",
    count: 2,
    hasCompletedOnboarding: true,
  });

  assert.equal((await setClaudeOnboardingSkip(false, configPath)).enabled, false);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
    theme: "dark",
    count: 2,
  });
});

test("Claude onboarding toggle refuses to overwrite invalid configuration", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-onboarding-"));
  const configPath = path.join(directory, ".claude.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(configPath, "not-json\n", "utf8");

  await assert.rejects(() => setClaudeOnboardingSkip(true, configPath), SyntaxError);
  assert.equal(await fs.readFile(configPath, "utf8"), "not-json\n");
});
