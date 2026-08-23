import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  applySkillSelection,
  buildInstallSkillArgs,
  buildUninstallSkillArgs,
  findProducedSkillDirs,
  importSkill,
  moveSkillDir,
  parseSkillsHomepage,
  parseSkillsManifest,
  parseSkillsSitemap,
  skillCommandErrorMessage,
  stagingInstallEnv,
  syncBuiltInUserSkills,
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

test("parseSkillsSitemap indexes skills outside the leaderboard", () => {
  assert.deepEqual(
    parseSkillsSitemap(`
      <url><loc>https://skills.sh/mattpocock/skills/grill-me</loc></url>
      <url><loc>https://skills.sh/site/example.com/remote-skill</loc></url>
      <url><loc>https://skills.sh/</loc></url>
    `),
    [
      {
        name: "grill-me",
        owner: "mattpocock",
        repo: "skills",
        installCount: 0,
        source: "mattpocock/skills",
        url: "https://github.com/mattpocock/skills",
      },
      {
        name: "remote-skill",
        owner: undefined,
        repo: undefined,
        installCount: 0,
        source: "example.com",
        url: "https://example.com",
      },
    ],
  );
});

test("parseSkillsManifest normalizes origins and drops malformed entries", () => {
  assert.deepEqual(
    parseSkillsManifest(
      JSON.stringify({
        "from-library": { origin: "skills.sh", source: "mattpocock/skills" },
        "no-origin": { source: "https://example.com/x" },
        "bad-origin": { origin: "nonsense" },
        "not-an-object": 42,
      }),
    ),
    {
      "from-library": { origin: "skills.sh", source: "mattpocock/skills" },
      "no-origin": { origin: "manual", source: "https://example.com/x" },
      "bad-origin": { origin: "manual" },
    },
  );
});

test("parseSkillsManifest tolerates invalid or non-object JSON", () => {
  assert.deepEqual(parseSkillsManifest("not json"), {});
  assert.deepEqual(parseSkillsManifest("[1,2,3]"), {});
  assert.deepEqual(parseSkillsManifest("null"), {});
});

test("stagingInstallEnv redirects each agent's global skills directory", () => {
  assert.deepEqual(stagingInstallEnv("claude", "/tmp/stage"), {
    CLAUDE_CONFIG_DIR: "/tmp/stage",
  });
  assert.deepEqual(stagingInstallEnv("codex", "/tmp/stage"), {
    CODEX_HOME: "/tmp/stage",
  });
});

test("syncBuiltInUserSkills seeds both agents without overwriting user skills", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-built-in-skill-"));
  try {
    const sourceRoot = path.join(base, "built-ins");
    const paths = { claude: [path.join(base, "claude-live")], codex: [path.join(base, "codex-live")] };
    const stagingRoots = { claude: path.join(base, "claude-user"), codex: path.join(base, "codex-user") };
    const source = path.join(sourceRoot, "osheep-json");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "description: built-in\n", "utf8");
    const existing = path.join(stagingRoots.codex, "osheep-json");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "SKILL.md"), "description: user version\n", "utf8");
    const enabled = path.join(paths.claude[0], "osheep-json");
    await fs.mkdir(enabled, { recursive: true });
    await fs.writeFile(path.join(enabled, "SKILL.md"), "description: enabled\n", "utf8");

    await syncBuiltInUserSkills({ paths, stagingRoots, userSkillsRoot: sourceRoot });

    await assert.rejects(fs.access(path.join(stagingRoots.claude, "osheep-json", "SKILL.md")));
    assert.equal(await fs.readFile(path.join(existing, "SKILL.md"), "utf8"), "description: user version\n");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("moveSkillDir relocates a skill folder across directories and removes the source", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-skill-move-"));
  try {
    const src = path.join(base, "src", "my-skill");
    const dest = path.join(base, "dest-parent", "my-skill");
    await fs.mkdir(path.join(src, "nested"), { recursive: true });
    await fs.writeFile(path.join(src, "SKILL.md"), "name: my-skill\n", "utf8");
    await fs.writeFile(path.join(src, "nested", "extra.txt"), "hello", "utf8");

    await moveSkillDir(src, dest);

    assert.equal(await fs.readFile(path.join(dest, "SKILL.md"), "utf8"), "name: my-skill\n");
    assert.equal(await fs.readFile(path.join(dest, "nested", "extra.txt"), "utf8"), "hello");
    await assert.rejects(fs.access(src));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("findProducedSkillDirs discovers skills below hidden CLI output directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-skill-output-"));
  try {
    const skill = path.join(root, ".agents", "skills", "hidden-skill");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\ndescription: test\n---\n", "utf8");
    assert.deepEqual(await findProducedSkillDirs(root), [skill]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("applySkillSelection only moves skills between user and enabled groups", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-skill-selection-"));
  const paths = {
    claude: [path.join(base, "claude-live"), path.join(base, "shared-live")],
    codex: [path.join(base, "codex-live"), path.join(base, "shared-live")],
  };
  const stagingRoots = {
    claude: path.join(base, "claude-user"),
    codex: path.join(base, "codex-user"),
  };
  const writeSkill = async (root: string, name: string, marker: string) => {
    const directory = path.join(root, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), `description: ${marker}\n`, "utf8");
  };

  try {
    await writeSkill(stagingRoots.codex, "enable-me", "staged");
    await writeSkill(paths.codex[0], "disable-me", "codex only");
    await writeSkill(paths.claude[0], "shared-skill", "claude private");
    await writeSkill(paths.codex[1], "shared-skill", "shared");

    const snapshot = await applySkillSelection(
      { agent: "codex", selectedNames: ["enable-me", "unknown-skill"] },
      { paths, stagingRoots, userSkillsRoot: path.join(base, "no-built-ins") },
    );

    assert.deepEqual(
      snapshot.enabled
        .filter((skill) => skill.agents.includes("codex"))
        .map((skill) => skill.name),
      ["enable-me"],
    );
    assert.deepEqual(
      snapshot.user
        .filter((skill) => skill.agent === "codex")
        .map((skill) => skill.name),
      ["disable-me", "shared-skill"],
    );
    assert.equal(
      await fs.readFile(path.join(paths.claude[0], "shared-skill", "SKILL.md"), "utf8"),
      "description: claude private\n",
    );
    assert.ok(
      snapshot.enabled.some(
        (skill) => skill.name === "shared-skill" && skill.agents.includes("claude"),
      ),
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("importSkill rejects a folder upload without SKILL.md", async () => {
  await assert.rejects(
    importSkill({
      agent: "codex",
      files: [{ path: "not-a-skill/README.md", data: "cmVhZG1l" }],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_FOLDER",
  );
});
