import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInstallSkillArgs,
  buildUninstallSkillArgs,
  parseSkillsHomepage,
  skillCommandErrorMessage,
  toSkillsWindowsCommandLine,
} from "./skills.js";

test("toSkillsWindowsCommandLine quotes npx paths and enables UTF-8 output", () => {
  assert.equal(
    toSkillsWindowsCommandLine("C:/Users/Example User/npm/npx.cmd", [
      "--yes",
      "skills",
      "add",
      "https://github.com/mattpocock/skills",
      "--skill",
      "grill-me",
      "-a",
      "codex",
    ]),
    'chcp 65001 >nul & call "C:/Users/Example User/npm/npx.cmd" "--yes" "skills" "add" "https://github.com/mattpocock/skills" "--skill" "grill-me" "-a" "codex"',
  );
});

test("skill command args use global non-interactive agent-compatible installs", () => {
  assert.deepEqual(
    buildInstallSkillArgs(
      {
        source: "https://github.com/mattpocock/skills",
        skill: "grill-me",
        agents: ["claude", "codex"],
      },
      "windows",
    ),
    [
      "--yes",
      "skills",
      "add",
      "https://github.com/mattpocock/skills",
      "--skill",
      "grill-me",
      "-a",
      "claude-code",
      "codex",
      "-g",
      "-y",
      "--copy",
    ],
  );
  assert.deepEqual(buildUninstallSkillArgs("grill-me", ["claude"]), [
    "--yes",
    "skills",
    "remove",
    "grill-me",
    "-a",
    "claude-code",
    "-g",
    "-y",
  ]);
});

test("skillCommandErrorMessage strips ANSI banners and keeps the real error", () => {
  assert.equal(
    skillCommandErrorMessage(
      "\u001b[38;5;250m███████╗██╗  ██╗\u001b[0m\n",
      "\u001b[33m⚠ Skipped C:/Temp/SKILL.md — YAML parse error: Nested mappings are not allowed\u001b[0m\n",
      "command failed",
    ),
    "⚠ Skipped C:/Temp/SKILL.md — YAML parse error: Nested mappings are not allowed",
  );
});

test("parseSkillsHomepage reads GitHub and well-known leaderboard cards", () => {
  const html = `
    <a class="group grid card" href="/mattpocock/skills/grill-me">
      <h3 class="font-semibold">grill-me</h3>
      <p class="font-mono">mattpocock/skills</p>
      <svg aria-label="Weekly installs: 1, 2"></svg>
      <div class="lg:col-span-2 text-right flex"><span class="font-mono text-sm text-foreground">901.7K</span></div>
    </a>
    <a class="group grid card" href="/site/open.example.com/example-skill">
      <h3>example-skill</h3>
      <p>open.example.com</p>
      <div class="lg:col-span-2 text-right"><span class="font-mono text-sm text-foreground">1.2M</span></div>
    </a>
  `;

  assert.deepEqual(parseSkillsHomepage(html), [
    {
      name: "grill-me",
      owner: "mattpocock",
      repo: "skills",
      installCount: 901_700,
      source: "mattpocock/skills",
      url: "https://github.com/mattpocock/skills",
    },
    {
      name: "example-skill",
      owner: undefined,
      repo: undefined,
      installCount: 1_200_000,
      source: "open.example.com",
      url: "https://open.example.com",
    },
  ]);
});
