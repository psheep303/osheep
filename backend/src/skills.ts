import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { APP_SETTINGS_DIR } from "./app-settings.js";
import { toWindowsCmdCommandLine } from "./codex-plugins.js";
import { platform } from "./config.js";
import { ApiError } from "./errors.js";
import { findExecutable } from "./runtime-tools.js";

const execFileAsync = promisify(execFile);
export type SkillAgent = "claude" | "codex";

export interface InstalledSkill {
  name: string;
  description?: string;
  path: string;
  agents: SkillAgent[];
  source: "local" | "skills.sh";
}

export type SkillOrigin = "skills.sh" | "manual";

export interface SkillManifestEntry {
  origin: SkillOrigin;
  source?: string;
}

export type SkillsManifest = Record<string, SkillManifestEntry>;

export interface StagedSkill {
  name: string;
  description?: string;
  path: string;
  agent: SkillAgent;
  origin: SkillOrigin;
  source?: string;
}

export interface SkillsSnapshot {
  enabled: InstalledSkill[];
  user: StagedSkill[];
  paths: Record<SkillAgent, string[]>;
}

export interface SkillImportFile {
  path: string;
  data: string;
}

export function parseSkillsManifest(text: string): SkillsManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: SkillsManifest = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const origin: SkillOrigin = entry.origin === "skills.sh" ? "skills.sh" : "manual";
    const source = typeof entry.source === "string" ? entry.source : undefined;
    result[name] = source ? { origin, source } : { origin };
  }
  return result;
}

export function stagingInstallEnv(agent: SkillAgent, dir: string): Record<string, string> {
  return agent === "claude" ? { CLAUDE_CONFIG_DIR: dir } : { CODEX_HOME: dir };
}

export async function moveSkillDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
  await fs.rm(src, { recursive: true, force: true });
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
  const claudeDir = path.resolve(process.env.CLAUDE_CONFIG_DIR || process.env.OSHEEP_CLAUDE_CONFIG_DIR || path.join(home(), ".claude"));
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

function stagingRoot(agent: SkillAgent): string {
  // Skills managed by Osheep belong beside the backend settings/database.
  // Do not use the host home directory or a caller-provided staging override:
  // desktop and web deployments must share the same backend/.osheep store.
  return path.join(APP_SETTINGS_DIR, "skills", agent);
}

function manifestPath(agent: SkillAgent): string {
  return path.join(stagingRoot(agent), "manifest.json");
}

async function readManifest(agent: SkillAgent): Promise<SkillsManifest> {
  try {
    return parseSkillsManifest(await fs.readFile(manifestPath(agent), "utf8"));
  } catch {
    return {};
  }
}

async function writeManifest(agent: SkillAgent, manifest: SkillsManifest): Promise<void> {
  const root = stagingRoot(agent);
  await fs.mkdir(root, { recursive: true });
  const tempPath = path.join(root, `.manifest.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, manifestPath(agent));
}

async function listStaged(agent: SkillAgent): Promise<StagedSkill[]> {
  const root = stagingRoot(agent);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const manifest = await readManifest(agent);
  const result: StagedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      await fs.access(path.join(directory, "SKILL.md"));
    } catch {
      continue;
    }
    const base = await readSkill(entry.name, directory, [agent]);
    const record = manifest[entry.name];
    result.push({
      name: entry.name,
      description: base.description,
      path: directory,
      agent,
      origin: record?.origin ?? "manual",
      source: record?.source,
    });
  }
  return result;
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
  const staged = [...(await listStaged("claude")), ...(await listStaged("codex"))];
  return {
    enabled: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name)),
    user: staged.sort((a, b) => a.name.localeCompare(b.name)),
    paths,
  };
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

async function runNpx(args: string[], extraEnv?: Record<string, string>): Promise<string> {
  const command = findExecutable(platform === "windows" ? "npx.cmd" : "npx") ?? findExecutable("npx");
  if (!command) throw new ApiError(409, "NPX_NOT_FOUND", "Node.js/npx is required to manage skills");
  try {
    const result = await execFileAsync(
      platform === "windows" ? (process.env.ComSpec ?? "cmd.exe") : command,
      platform === "windows"
        ? ["/d", "/s", "/c", toSkillsWindowsCommandLine(command, args)]
        : args,
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: platform === "windows", maxBuffer: 8 * 1024 * 1024, timeout: ACTION_TIMEOUT_MS, env: extraEnv ? { ...process.env, ...extraEnv } : process.env },
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

function enableTargetDir(agent: SkillAgent): string {
  return skillPaths()[agent][0];
}

async function findEnabledSkillDir(name: string, agent: SkillAgent): Promise<string | null> {
  for (const root of skillPaths()[agent]) {
    const candidate = path.join(root, name);
    try {
      await fs.access(path.join(candidate, "SKILL.md"));
      return candidate;
    } catch {
      // Not enabled in this directory; keep looking.
    }
  }
  return null;
}

export async function findProducedSkillDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (SAFE_NAME.test(entry.name)) {
      try {
        await fs.access(path.join(directory, "SKILL.md"));
        result.push(directory);
        continue;
      } catch {
        // Continue looking below directories that are not skills themselves.
      }
    }
    result.push(...(await findProducedSkillDirs(directory, depth + 1)));
  }
  return result;
}

async function skillDirsInRoots(roots: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const root of roots) {
    for (const directory of await findProducedSkillDirs(root)) {
      result.set(path.basename(directory), directory);
    }
  }
  return result;
}

/**
 * Install a skill into the osheep staging area (the "user" group) rather than
 * the agent's live skills directory. The skills CLI installs globally into the
 * config directory named by CLAUDE_CONFIG_DIR / CODEX_HOME, so we point those at
 * a throwaway directory, then relocate the produced skill folders into staging.
 */
export async function installSkill(input: {
  source: string;
  skill?: string;
  agent: SkillAgent;
  origin?: SkillOrigin;
}) {
  if (!SAFE_SOURCE.test(input.source.trim())) throw new ApiError(400, "INVALID_SKILL_SOURCE", "Skill source must be a URL or GitHub source");
  if (input.skill && !SAFE_NAME.test(input.skill)) throw new ApiError(400, "INVALID_SKILL_NAME", "Skill name contains unsupported characters");
  const origin: SkillOrigin = input.origin === "skills.sh" ? "skills.sh" : "manual";
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-skill-install-"));
  const liveBefore = await skillDirsInRoots(skillPaths()[input.agent]);
  try {
    const args = buildInstallSkillArgs({ source: input.source, skill: input.skill, agents: [input.agent] });
    if (!args.includes("--copy")) args.push("--copy");
    let commandError: unknown;
    try {
      await runNpx(args, stagingInstallEnv(input.agent, temp));
    } catch (error) {
      // The CLI can exit non-zero after copying a valid skill (for example
      // when another skill in a repository has invalid YAML). Inspect outputs
      // before surfacing the command failure so successful skills are not left
      // in the live directory or reported as a failed install.
      commandError = error;
    }
    const produced = await findProducedSkillDirs(temp);
    // Older skills CLI versions may ignore CLAUDE_CONFIG_DIR/CODEX_HOME and
    // write directly to the live global directory. Capture only newly-created
    // skills and move them to user storage.
    if (produced.length === 0) {
      const liveAfter = await skillDirsInRoots(skillPaths()[input.agent]);
      for (const [name, directory] of liveAfter) {
        if (!liveBefore.has(name)) produced.push(directory);
      }
    }
    if (produced.length === 0 && commandError) throw commandError;
    if (produced.length === 0) throw new ApiError(502, "SKILL_INSTALL_EMPTY", "The installer produced no skill to stage");
    const manifest = await readManifest(input.agent);
    for (const sourceDirectory of produced) {
      const name = path.basename(sourceDirectory);
      const destination = path.join(stagingRoot(input.agent), name);
      if (path.resolve(sourceDirectory) !== path.resolve(destination)) {
        await moveSkillDir(sourceDirectory, destination);
      }
      manifest[name] = input.source.trim() ? { origin, source: input.source.trim() } : { origin };
    }
    await writeManifest(input.agent, manifest);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  return getSkillsSnapshot();
}

/** Import a local skill directory into Osheep's user-managed skill store. */
export async function importSkill(input: {
  agent: SkillAgent;
  sourcePath?: string;
  files?: SkillImportFile[];
}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-skill-import-"));
  try {
    let sourceDirectory = temp;
    if (input.sourcePath) {
      const source = path.resolve(input.sourcePath);
      const stat = await fs.stat(source).catch(() => null);
      if (!stat?.isDirectory()) throw new ApiError(400, "INVALID_SKILL_FOLDER", "Selected item is not a folder");
      sourceDirectory = source;
    } else if (input.files?.length) {
      const normalizedFiles = input.files.map((file) => ({
        ...file,
        parts: file.path.replaceAll("\\", "/").replace(/^\/+/, "").split("/").filter(Boolean),
      }));
      const firstParts = new Set(normalizedFiles.map((file) => file.parts[0]).filter(Boolean));
      const stripDirectory = !normalizedFiles.some((file) => file.parts.length === 1 && file.parts[0] === "SKILL.md") && firstParts.size === 1;
      for (const file of normalizedFiles) {
        const parts = stripDirectory ? file.parts.slice(1) : file.parts;
        if (parts.length < 1 || parts.some((part) => part === "." || part === ".." || !SAFE_NAME.test(part))) {
          throw new ApiError(400, "INVALID_SKILL_FOLDER", "Selected folder contains an invalid file path");
        }
        const destination = path.join(temp, ...parts);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        let content: Buffer;
        try {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error("invalid base64");
          content = Buffer.from(file.data, "base64");
        } catch {
          throw new ApiError(400, "INVALID_SKILL_FOLDER", "Selected folder contains an unreadable file");
        }
        await fs.writeFile(destination, content);
      }
    } else {
      throw new ApiError(400, "INVALID_SKILL_FOLDER", "Select a skill folder to import");
    }

    const skillFile = path.join(sourceDirectory, "SKILL.md");
    await fs.access(skillFile).catch(() => {
      throw new ApiError(400, "INVALID_SKILL_FOLDER", "Selected folder must contain SKILL.md");
    });
    const name = input.sourcePath
      ? path.basename(sourceDirectory)
      : path.basename(input.files?.[0]?.path.replaceAll("\\", "/").split("/").filter(Boolean)[0] ?? "");
    if (!SAFE_NAME.test(name)) throw new ApiError(400, "INVALID_SKILL_NAME", "Skill folder name contains unsupported characters");
    const destination = path.join(stagingRoot(input.agent), name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(sourceDirectory, destination, { recursive: true });
    const manifest = await readManifest(input.agent);
    manifest[name] = { origin: "manual" };
    await writeManifest(input.agent, manifest);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  return getSkillsSnapshot();
}

/** Move a staged skill into the agent's live skills directory. */
export async function enableSkill(input: { name: string; agent: SkillAgent }) {
  if (!SAFE_NAME.test(input.name)) throw new ApiError(400, "INVALID_SKILL_NAME", "Skill name contains unsupported characters");
  const from = path.join(stagingRoot(input.agent), input.name);
  try {
    await fs.access(path.join(from, "SKILL.md"));
  } catch {
    throw new ApiError(404, "SKILL_NOT_FOUND", "This skill is not in the staging area");
  }
  await moveSkillDir(from, path.join(enableTargetDir(input.agent), input.name));
  return getSkillsSnapshot();
}

/** Move an enabled skill out of the agent's live directory back into staging. */
export async function disableSkill(input: { name: string; agent: SkillAgent }) {
  if (!SAFE_NAME.test(input.name)) throw new ApiError(400, "INVALID_SKILL_NAME", "Skill name contains unsupported characters");
  const from = await findEnabledSkillDir(input.name, input.agent);
  if (!from) throw new ApiError(404, "SKILL_NOT_FOUND", "This skill is not enabled");
  await moveSkillDir(from, path.join(stagingRoot(input.agent), input.name));
  const manifest = await readManifest(input.agent);
  if (!manifest[input.name]) {
    manifest[input.name] = { origin: "manual" };
    await writeManifest(input.agent, manifest);
  }
  return getSkillsSnapshot();
}

/** Delete a staged skill and forget its provenance. */
export async function deleteSkill(input: { name: string; agent: SkillAgent }) {
  if (!SAFE_NAME.test(input.name)) throw new ApiError(400, "INVALID_SKILL_NAME", "Skill name contains unsupported characters");
  await fs.rm(path.join(stagingRoot(input.agent), input.name), { recursive: true, force: true });
  const manifest = await readManifest(input.agent);
  if (manifest[input.name]) {
    delete manifest[input.name];
    await writeManifest(input.agent, manifest);
  }
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

/** Extract the complete skill route index published by skills.sh. The home
 * page is intentionally limited to the leaderboard, while the sitemap keeps
 * the long tail searchable without requiring an API token. */
export function parseSkillsSitemap(xml: string): SkillsLibraryItem[] {
  const result: SkillsLibraryItem[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<loc>\s*https?:\/\/[^<]+?\/([^<?#]+)\s*<\/loc>/gi)) {
    const route = decodeURIComponent(match[1] ?? "").replace(/^\/+|\/+$/g, "");
    const parts = route.split("/").filter(Boolean);
    if (parts.length < 3) continue;
    const name = parts.at(-1) ?? "";
    if (!SAFE_NAME.test(name)) continue;
    const isSite = parts[0] === "site";
    const source = isSite ? parts[1] : parts.slice(0, -1).join("/");
    if (!source || !SAFE_NAME.test(source.split("/").at(-1) ?? "")) continue;
    const key = `${source}/${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceParts = source.split("/");
    const host = isSite ? sourceParts[0] : undefined;
    result.push({
      name,
      owner: !host && sourceParts.length > 1 ? sourceParts[0] : undefined,
      repo: !host && sourceParts.length > 1 ? sourceParts[1] : undefined,
      installCount: 0,
      source,
      url: host ? `https://${host}` : `https://github.com/${source}`,
    });
  }
  return result;
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
  const homepage = parseSkillsHomepage(await response.text());
  // Sitemap fetch is best-effort: older skills.sh deployments may not expose
  // it, but the leaderboard remains a useful fallback in that case.
  let indexed: SkillsLibraryItem[] = [];
  try {
    const sitemapResponse = await fetch("https://www.skills.sh/sitemap.xml", {
      headers: { accept: "application/xml,text/xml" },
      signal: AbortSignal.timeout(8_000),
    });
    if (sitemapResponse.ok) {
      const sitemapText = await sitemapResponse.text();
      indexed = parseSkillsSitemap(sitemapText);
      // Some deployments publish a sitemap index instead of skill URLs.
      if (indexed.length === 0) {
        const childUrls = [...sitemapText.matchAll(/<loc>\s*(https?:\/\/[^<]*sitemap[^<]*)\s*<\/loc>/gi)]
          .map((match) => match[1])
          .filter((url): url is string => Boolean(url))
          .slice(0, 50);
        const childResults = await Promise.allSettled(
          childUrls.map(async (url) => {
            const child = await fetch(url, {
              headers: { accept: "application/xml,text/xml" },
              signal: AbortSignal.timeout(8_000),
            });
            return child.ok ? parseSkillsSitemap(await child.text()) : [];
          }),
        );
        indexed = childResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
      }
    }
  } catch {
    // Keep the public catalog usable when sitemap access is unavailable.
  }
  const byKey = new Map<string, SkillsLibraryItem>();
  // Keep the homepage's ranked order first so an empty search still shows the
  // official top 50; sitemap-only entries extend the searchable index after it.
  for (const item of [...homepage, ...indexed]) {
    const key = `${item.source ?? `${item.owner ?? ""}/${item.repo ?? ""}`}/${item.name}`;
    const existing = byKey.get(key);
    // Homepage entries carry ranking/count metadata; preserve it over sitemap
    // placeholders while retaining the complete sitemap index.
    byKey.set(key, existing && existing.installCount > item.installCount ? existing : item);
  }
  const skills = [...byKey.values()];
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
  // Homepage order is the official ranking. For search results, known counts
  // are sorted first while sitemap-only matches remain searchable at count 0.
  if (normalizedQuery) filtered.sort((a, b) => b.installCount - a.installCount || a.name.localeCompare(b.name));
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
  const skills = raw.map(normalizeLibraryItem).filter((item): item is SkillsLibraryItem => item !== null);
  return {
    skills: skills.slice(0, 50),
    total: typeof object.total === "number" ? object.total : skills.length,
    next: typeof object.next === "string" ? object.next : null,
  };
}
