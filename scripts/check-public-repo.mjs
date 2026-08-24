import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const trackedFiles = git(["ls-files", "-z"])
  .split("\0")
  .filter(Boolean);
const presentTrackedFiles = trackedFiles.filter((file) => existsSync(file));

const untrackedFiles = git(["ls-files", "--others", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean);

const repositoryFiles = [...new Set([...presentTrackedFiles, ...untrackedFiles])];
const repositoryFileSet = new Set(repositoryFiles.map((file) => file.replaceAll("\\", "/")));

const ignoredTrackedFiles = git(["ls-files", "-ci", "--exclude-standard", "-z"])
  .split("\0")
  .filter((file) => file && existsSync(file));

const forbiddenPaths = repositoryFiles.filter((file) => {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  if (
    /^(?:\.agents|\.claude|\.codex|\.superpowers|docs\/(?:reports|superpowers)|logs)\//.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/(?:^|\/)\.env(?:\.|$)/.test(normalized) && !normalized.endsWith(".env.example")) return true;
  if (/(?:^|\/)(?:credentials|secrets)(?:\.[^/]*)?\.(?:json|ya?ml)$/.test(normalized)) {
    return true;
  }
  return /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|mobileprovision)$/.test(normalized);
});

const secretPatterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI-style key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

const historyPattern = [
  "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
  "(^|[^A-Za-z0-9])sk-(proj-)?[A-Za-z0-9_-]{20,}",
  "(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}",
  "(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}",
  "(^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{20,}",
].join("|");

const secretHits = [];
for (const file of repositoryFiles) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content)) secretHits.push(`${file}: ${name}`);
  }
}

const historyHits = [];
if (process.argv.includes("--history")) {
  const revisions = git(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
  for (const revision of revisions) {
    const result = spawnSync(
      "git",
      ["grep", "-Il", "-E", "-e", historyPattern, revision, "--", "."],
      { encoding: "utf8" },
    );
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(result.stderr || `git grep failed for ${revision}`);
    }
    for (const file of result.stdout.split("\n").filter(Boolean)) {
      historyHits.push(`${revision.slice(0, 12)}:${file}: possible historical secret`);
    }
  }
}

const documentationPairs = [
  ["README.md", "README.en.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.en.md"],
  ["SECURITY.md", "SECURITY.en.md"],
  ["CODE_OF_CONDUCT.md", "CODE_OF_CONDUCT.en.md"],
  ["backend/README.md", "backend/README.en.md"],
  ["backend/template-library/README.md", "backend/template-library/README.en.md"],
];
const documentationFailures = [];
for (const [chinese, english] of documentationPairs) {
  if (!repositoryFileSet.has(chinese)) documentationFailures.push(`${chinese}: missing Simplified Chinese document`);
  if (!repositoryFileSet.has(english)) {
    documentationFailures.push(`${english}: missing English document`);
  }
}

const failures = [
  ...ignoredTrackedFiles.map((file) => `${file}: tracked even though .gitignore excludes it`),
  ...forbiddenPaths.map((file) => `${file}: forbidden public-repository path`),
  ...secretHits,
  ...historyHits,
  ...documentationFailures,
];

if (failures.length > 0) {
  console.error("Public repository hygiene check failed:");
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const historyMessage = process.argv.includes("--history") ? " and all reachable history" : "";
  console.log(
    `Public repository hygiene check passed (${presentTrackedFiles.length} present tracked files${historyMessage}).`,
  );
}
