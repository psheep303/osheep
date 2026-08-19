import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { ApiError } from "./errors.js";
import { platform } from "./config.js";
import { findExecutable } from "./runtime-tools.js";
import { toWindowsCmdCommandLine } from "./codex-plugins.js";

const execFileAsync = promisify(execFile);
export type SkillAgent = "claude" | "codex";

export interface InstalledSkill {
  name: string;
  description?: string;
  path: string;
  agents: SkillAgent[];
  source: "local" | "skills.sh";
}

export interface SkillsSnapshot {
  installed: InstalledSkill[];
  paths: Record<SkillAgent, string[]>;
}

export interface SkillsLibraryItem {
  name: string;
  owner?: string;
  repo?: string;
  description?: string;
  installCount: number;
  source?: string;
  url?: string;
}

export interface SkillsLibraryResult {
  skills: SkillsLibraryItem[];
  total?: number;
  next?: string | null;
}

const ACTION_TIMEOUT_MS = 5 * 60_000;
const LIBRARY_CACHE_MS = 5 * 60_000;
const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;
const SAFE_SOURCE = /^(?:https?:\/\/|git@|github:)[^\s"'<>|&;]+$/i;
let publicLibraryCache: { expiresAt: number; skills: SkillsLibraryItem[] } | null = null;

function home(): string {
  return os.homedir() || ".";
}

function skillPaths(): Record<SkillAgent, string[]> {
  const shared = path.resolve(process.env.OSHEEP_AGENTS_SKILLS_DIR || path.join(home(), ".agents", "skills"));
  const claudeDir = path.resolve(process.env.OSHEEP_CLAUDE_CONFIG_DIR || path.join(home(), ".claude"));
  const codexDir = path.resolve(process.env.CODEX_HOME || process.env.OSHEEP_CODEX_CONFIG_DIR || path.join(home(), ".codex"));
  return {
    claude: [path.join(claudeDir, "skills"), shared],
    codex: [path.join(codexDir, "skills"), shared],
  };
}

async function readSkill(name: string, directory: string, agents: SkillAgent[]): Promise<InstalledSkill> {
  let description: string | undefined;
  try {
    const text = await fs.readFile(path.join(directory, "SKILL.md"), "utf8");
    const match = text.match(/^description:\s*["']?(.+?)["']?\s*$/im);
    description = match?.[1]?.trim();
  } catch {
    // A skill directory may be valid without a frontmatter description.
  }
  return { name, description, path: directory, agents, source: "local" };
}

async function listDirectory(root: string, agent: SkillAgent): Promise<InstalledSkill[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const result: InstalledSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
      try {
        await fs.access(path.join(root, entry.name, "SKILL.md"));
        result.push(await readSkill(entry.name, path.join(root, entry.name), [agent]));
      } catch {
        // Ignore non-skill directories.
      }
    }
    return result;
  } catch {
    return [];
  }
}

export async function getSkillsSnapshot(): Promise<SkillsSnapshot> {
  const paths = skillPaths();
  const byPath = new Map<string, InstalledSkill>();
  for (const agent of ["claude", "codex"] as const) {
    for (const item of await Promise.all(paths[agent].map((root) => listDirectory(root, agent)))) {
      for (const skill of item) {
        const existing = byPath.get(skill.path);
        if (existing) existing.agents = [...new Set([...existing.agents, ...skill.agents])];
        else byPath.set(skill.path, skill);
      }
    }
  }
  return { installed: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name)), paths };
}

export function skillCommandErrorMessage(
  stderr: string | undefined,
  stdout: string | undefined,
  fallback: string,
): string {
  const lines = stripVTControlCharacters(`${stderr ?? ""}\n${stdout ?? ""}`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/[█]{3,}|[╔╗╚╝║═]{3,}/u.test(line) &&
        !/^Active code page:/i.test(line),
    );
  const meaningful = lines.find((line) =>
    /YAML parse error|\b(?:error|failed|invalid|skipped|not found|timed out|cancelled)\b/i.test(line),
  );
  return (meaningful ?? lines.at(-1) ?? stripVTControlCharacters(fallback)).slice(0, 1200);
}

function parseError(error: unknown): string {
  if (error instanceof Error) {
    const commandError = error as Error & { stdout?: string; stderr?: string };
    return skillCommandErrorMessage(commandError.stderr, commandError.stdout, error.message);
  }
  return stripVTControlCharacters(String(error));
}

async function runNpx(args: string[]): Promise<string> {
  const command = findExecutable(platform === "windows" ? "npx.cmd" : "npx") ?? findExecutable("npx");
  if (!command) throw new ApiError(409, "NPX_NOT_FOUND", "Node.js/npx is required to manage skills");
  try {
    const result = await execFileAsync(
      platform === "windows" ? (process.env.ComSpec ?? "cmd.exe") : command,
      platform === "windows"
        ? ["/d", "/s", "/c", toSkillsWindowsCommandLine(command, args)]
        : args,
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: platform === "windows", maxBuffer: 8 * 1024 * 1024, timeout: ACTION_TIMEOUT_MS },
    );
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  } catch (error) {
    throw new ApiError(502, "SKILL_COMMAND_FAILED", parseError(error));
  }
}

export function toSkillsWindowsCommandLine(command: string, args: string[]): string {
  return `chcp 65001 >nul & ${toWindowsCmdCommandLine(command, args)}`;
}

function cliAgent(agent: SkillAgent): string {
  return agent === "claude" ? "claude-code" : "codex";
}

export function buildInstallSkillArgs(
  input: { source: string; skill?: string; agents: SkillAgent[] },
  runtimePlatform: "windows" | "macos" | "linux" = platform,
): string[] {
  const args = ["--yes", "skills", "add", input.source.trim()];
  if (input.skill) args.push("--skill", input.skill);
  args.push("-a", ...input.agents.map(cliAgent), "-g", "-y");
  if (runtimePlatform === "windows") args.push("--copy");
  return args;
}

export function buildUninstallSkillArgs(name: string, agents: SkillAgent[]): string[] {
  return ["--yes", "skills", "remove", name, "-a", ...agents.map(cliAgent), "-g", "-y"];
}

export async function installSkill(input: { source: string; skill?: string; agents: SkillAgent[] }) {
  if (!SAFE_SOURCE.test(input.source.trim())) throw new ApiError(400, "INVALID_SKILL_SOURCE", "Skill source must be a URL or GitHub source");
  if (input.skill && !SAFE_NAME.test(input.skill)) throw new ApiError(400, "INVALID_SKILL_NAME", "Skill name contains unsupported characters");
  if (input.agents.length === 0) throw new ApiError(400, "INVALID_SKILL_AGENTS", "Select at least one agent");
  await runNpx(buildInstallSkillArgs(input));
  return getSkillsSnapshot();
}

export async function uninstallSkill(input: { name: string; agents: SkillAgent[] }) {
  if (!SAFE_NAME.test(input.name)) throw new ApiError(400, "INVALID_SKILL_NAME", "Skill name contains unsupported characters");
  if (input.agents.length === 0) throw new ApiError(400, "INVALID_SKILL_AGENTS", "Select at least one agent");
  await runNpx(buildUninstallSkillArgs(input.name, input.agents));
  return getSkillsSnapshot();
}

function normalizeLibraryItem(value: unknown): SkillsLibraryItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : typeof item.skill === "string" ? item.skill : "";
  if (!name) return null;
  const count = item.installCount ?? item.installs ?? item.downloads ?? item.install_count;
  const source = typeof item.source === "string" ? item.source : undefined;
  const sourceParts = source?.split("/") ?? [];
  return {
    name,
    owner: typeof item.owner === "string" ? item.owner : sourceParts.length > 1 ? sourceParts[0] : undefined,
    repo: typeof item.repo === "string" ? item.repo : sourceParts.length > 1 ? sourceParts[1] : undefined,
    description: typeof item.description === "string" ? item.description : undefined,
    installCount: typeof count === "number" ? count : Number(count) || 0,
    source,
    url: typeof item.installUrl === "string" ? item.installUrl : typeof item.url === "string" ? item.url : typeof item.sourceUrl === "string" ? item.sourceUrl : source ? `https://github.com/${source}` : undefined,
  };
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function parseCompactCount(value: string): number {
  const match = value.trim().replaceAll(",", "").match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return 0;
  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2]?.toUpperCase() ?? ""] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

export function parseSkillsHomepage(html: string): SkillsLibraryItem[] {
  const items: SkillsLibraryItem[] = [];
  const seen = new Set<string>();
  const cardPattern = /<a class="group grid[^"]*" href="\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(cardPattern)) {
    const route = match[1] ?? "";
    const card = match[2] ?? "";
    const nameMatch = card.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const sourceMatch = card.match(/<p[^>]*>([^<]+)<\/p>/);
    const countMatch = card.match(
      /<div class="lg:col-span-2 text-right[^"]*">[\s\S]*?<span class="font-mono text-sm text-foreground">([^<]+)<\/span>/,
    );
    if (!nameMatch || !sourceMatch || !countMatch) continue;
    const parts = route.split("/").filter(Boolean);
    if (parts.length < 3) continue;
    const name = decodeHtml(nameMatch[1] ?? parts.at(-1) ?? "").trim();
    const source = decodeHtml(sourceMatch[1] ?? parts.slice(0, -1).join("/")).trim();
    if (!name || !source || seen.has(`${source}/${name}`)) continue;
    seen.add(`${source}/${name}`);
    const sourceParts = source.split("/");
    const wellKnownHost = parts[0] === "site" ? parts[1] : undefined;
    const installUrl = wellKnownHost ? `https://${wellKnownHost}` : `https://github.com/${source}`;
    items.push({
      name,
      owner: !wellKnownHost && sourceParts.length > 1 ? sourceParts[0] : undefined,
      repo: !wellKnownHost && sourceParts.length > 1 ? sourceParts[1] : undefined,
      installCount: parseCompactCount(countMatch[1] ?? "0"),
      source,
      url: installUrl,
    });
  }
  return items;
}

async function getPublicSkillsLibrary(): Promise<SkillsLibraryItem[]> {
  if (publicLibraryCache && publicLibraryCache.expiresAt > Date.now()) {
    return publicLibraryCache.skills;
  }
  const response = await fetch("https://www.skills.sh/", {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new ApiError(502, "SKILLS_LIBRARY_FAILED", `skills.sh returned HTTP ${response.status}`);
  }
  const skills = parseSkillsHomepage(await response.text());
  if (skills.length === 0) {
    throw new ApiError(502, "SKILLS_LIBRARY_FAILED", "skills.sh returned no readable skills");
  }
  publicLibraryCache = { expiresAt: Date.now() + LIBRARY_CACHE_MS, skills };
  return skills;
}

async function searchPublicSkillsLibrary(query: string): Promise<SkillsLibraryResult> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const skills = await getPublicSkillsLibrary();
  const filtered = normalizedQuery
    ? skills.filter((item) =>
        `${item.name} ${item.owner ?? ""} ${item.repo ?? ""} ${item.source ?? ""}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : skills;
  return { skills: filtered.slice(0, 50), total: filtered.length, next: null };
}

export async function searchSkillsLibrary(query: string): Promise<SkillsLibraryResult> {
  const token = process.env.SKILLS_SH_API_TOKEN?.trim();
  if (!token) return await searchPublicSkillsLibrary(query);
  const configuredBase = process.env.SKILLS_SH_API_URL?.trim();
  const base = configuredBase
    ? `${configuredBase.replace(/\/$/, "")}${query.trim().length >= 2 && /\/skills$/.test(configuredBase) ? "/search" : ""}`
    : `https://skills.sh/api/v1/skills${query.trim().length >= 2 ? "/search" : ""}`;
  const url = new URL(base);
  if (query.trim().length >= 2) url.searchParams.set("q", query.trim());
  url.searchParams.set(query.trim().length >= 2 ? "limit" : "per_page", "50");
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) {
    return await searchPublicSkillsLibrary(query);
  }
  if (!response.ok) throw new ApiError(502, "SKILLS_LIBRARY_FAILED", `skills.sh returned HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  const object = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const raw = Array.isArray(body) ? body : Array.isArray(object.skills) ? object.skills : Array.isArray(object.data) ? object.data : [];
  return {
    skills: raw.map(normalizeLibraryItem).filter((item): item is SkillsLibraryItem => item !== null),
    total: typeof object.total === "number" ? object.total : undefined,
    next: typeof object.next === "string" ? object.next : null,
  };
}
