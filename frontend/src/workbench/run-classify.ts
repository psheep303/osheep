// Classify a shell command into one of several auto-allow buckets.
// The chat-runtime uses this to decide which `autoAllow` key gates the call.

export type RunCategory =
  | "network"
  | "install"
  | "git"
  | "test"
  | "other";

export interface CategoryDescriptor {
  key: RunCategory;
  label: string;
  hint: string;
  autoAllowKey:
    | "runNetwork"
    | "runInstall"
    | "runGit"
    | "runTest"
    | "runOther";
}

export const RUN_CATEGORIES: Record<RunCategory, CategoryDescriptor> = {
  network: {
    key: "network",
    label: "Network",
    hint: "网络探测：curl / wget / ping / dig / nslookup …",
    autoAllowKey: "runNetwork",
  },
  install: {
    key: "install",
    label: "Install",
    hint: "包安装：npm i / pnpm / yarn / pip / brew / apt …",
    autoAllowKey: "runInstall",
  },
  git: {
    key: "git",
    label: "Git",
    hint: "Git 命令：status / log / diff / branch / fetch …",
    autoAllowKey: "runGit",
  },
  test: {
    key: "test",
    label: "Test / Build",
    hint: "测试 / 构建：npm test / vitest / pytest / make …",
    autoAllowKey: "runTest",
  },
  other: {
    key: "other",
    label: "Run other",
    hint: "其它任意 shell 命令",
    autoAllowKey: "runOther",
  },
};

/**
 * Tokenize a command string into the first meaningful binary + its first
 * positional argument (if any). Strips env-var prefixes like `DEBUG=1`,
 * surrounding quotes, and leading whitespace.
 */
function firstTokens(command: string): { head: string; arg: string } {
  const trimmed = command.trim().replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
  const parts = trimmed.split(/\s+/);
  // Strip a leading `&` / `&&` / shell connectors if present (rare, defensive).
  const head = (parts[0] ?? "").toLowerCase();
  const arg = (parts[1] ?? "").toLowerCase();
  return { head: stripQuotes(head), arg: stripQuotes(arg) };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s.startsWith('"') || s.startsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

const NETWORK_BINARIES = new Set([
  "curl",
  "wget",
  "ping",
  "ping6",
  "dig",
  "nslookup",
  "host",
  "traceroute",
  "tracert",
  "nc",
  "netcat",
  "ssh",
  "scp",
  "rsync",
  "ftp",
  "sftp",
  "telnet",
]);

const GIT_BINARIES = new Set(["git", "gh", "hub"]);

const TEST_HEAD_BINARIES = new Set([
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "tox",
  "go",
  "cargo",
  "make",
  "ctest",
  "gradle",
  "mvn",
  "phpunit",
  "rspec",
  "tsc",
  "eslint",
  "prettier",
  "ruff",
  "mypy",
]);

const INSTALL_HEAD_ARGS: Array<[string, string[]]> = [
  ["npm", ["install", "i", "add", "ci"]],
  ["pnpm", ["install", "i", "add"]],
  ["yarn", ["add", "install"]],
  ["bun", ["install", "i", "add"]],
  ["pip", ["install"]],
  ["pip3", ["install"]],
  ["uv", ["pip", "add"]],
  ["poetry", ["add", "install"]],
  ["brew", ["install", "upgrade", "tap"]],
  ["apt", ["install", "update", "upgrade"]],
  ["apt-get", ["install", "update", "upgrade"]],
  ["dnf", ["install"]],
  ["yum", ["install"]],
  ["pacman", ["-S", "-Sy", "-Syu"]],
  ["go", ["install", "get"]],
  ["cargo", ["install", "add"]],
  ["choco", ["install"]],
  ["winget", ["install"]],
  ["scoop", ["install"]],
];

/**
 * Best-effort classifier. Falls through to "other" when nothing matches.
 *
 * Examples:
 *   `curl https://...`   → network
 *   `git status`         → git
 *   `npm install foo`    → install
 *   `npm test`           → test
 *   `vitest`             → test
 *   `node scripts/x.js`  → other
 */
export function classifyCommand(command: string): RunCategory {
  if (typeof command !== "string" || !command.trim()) return "other";
  const { head, arg } = firstTokens(command);

  // Network — straightforward whitelist.
  if (NETWORK_BINARIES.has(head)) return "network";

  // Install — head + first-arg pair.
  for (const [bin, args] of INSTALL_HEAD_ARGS) {
    if (head === bin && args.includes(arg)) return "install";
  }

  // Git family.
  if (GIT_BINARIES.has(head)) return "git";

  // Test / build heads.
  if (TEST_HEAD_BINARIES.has(head)) {
    // `cargo install` already classified as install above; here only build / test.
    return "test";
  }

  // npm run test / npm test patterns.
  if ((head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") &&
      (arg === "test" || arg === "run")) {
    return "test";
  }

  return "other";
}

export function categoryFor(command: string): CategoryDescriptor {
  return RUN_CATEGORIES[classifyCommand(command)];
}
