import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errors } from "./errors.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".vite",
  ".cache",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
const MAX_PREVIEW_LEN = 400;

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string[];
  exclude: string[];
  maxFiles: number;
  maxMatchesPerFile: number;
}

export interface SearchMatchLine {
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchFileMatch {
  path: string;
  lines: SearchMatchLine[];
}

export interface SearchResult {
  matches: SearchFileMatch[];
  truncated: boolean;
  filesScanned: number;
  elapsedMs: number;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(opts: SearchOptions): RegExp {
  let src: string;
  if (opts.regex) {
    src = opts.query;
  } else {
    src = escapeRegex(opts.query);
  }
  if (opts.wholeWord) {
    src = `(?:^|\\W)(${src})(?=$|\\W)`;
  }
  let flags = "g";
  if (!opts.caseSensitive) flags += "i";
  try {
    return new RegExp(src, flags);
  } catch (e) {
    throw errors.invalidQuery((e as Error).message);
  }
}

// Convert a glob like "src/**/*.ts" to RegExp.
function globToRegex(glob: string): RegExp {
  const g = glob.trim();
  if (!g) return /(?:)/;
  let re = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (g[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === ".") {
      re += "\\.";
      i += 1;
    } else if ("+()|^$[]{}\\".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesAny(relPath: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  for (const p of patterns) {
    if (p.test(relPath)) return true;
  }
  return false;
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, SNIFF_BYTES);
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / Math.max(1, len) > 0.3;
}

function trimPreview(line: string, matchStart: number, matchEnd: number): {
  preview: string;
  matchStart: number;
  matchEnd: number;
} {
  if (line.length <= MAX_PREVIEW_LEN) {
    return { preview: line, matchStart, matchEnd };
  }
  const wantStart = Math.max(0, matchStart - 80);
  const wantEnd = Math.min(line.length, wantStart + MAX_PREVIEW_LEN);
  let preview = line.slice(wantStart, wantEnd);
  let prefix = "";
  let suffix = "";
  if (wantStart > 0) {
    prefix = "…";
    preview = preview.slice(1);
  }
  if (wantEnd < line.length) {
    suffix = "…";
    preview = preview.slice(0, -1);
  }
  return {
    preview: prefix + preview + suffix,
    matchStart: matchStart - wantStart + (prefix ? 1 : 0),
    matchEnd: matchEnd - wantStart + (prefix ? 1 : 0),
  };
}

async function* walk(
  rootAbs: string,
  excludePatterns: RegExp[]
): AsyncGenerator<{ abs: string; rel: string }> {
  const stack: { abs: string; rel: string }[] = [{ abs: rootAbs, rel: "" }];
  while (stack.length) {
    const { abs, rel } = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (matchesAny(childRel, excludePatterns)) continue;
        if (matchesAny(childRel + "/", excludePatterns)) continue;
        stack.push({ abs: path.join(abs, e.name), rel: childRel });
      } else if (e.isFile()) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (matchesAny(childRel, excludePatterns)) continue;
        yield { abs: path.join(abs, e.name), rel: childRel };
      }
    }
  }
}

export async function searchWorkspace(
  workspaceRoot: string,
  opts: SearchOptions
): Promise<SearchResult> {
  const started = Date.now();
  if (!opts.query) {
    return { matches: [], truncated: false, filesScanned: 0, elapsedMs: 0 };
  }
  const pattern = buildPattern(opts);
  const includePatterns = opts.include.map(globToRegex);
  const excludePatterns = opts.exclude.map(globToRegex);

  const matches: SearchFileMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  for await (const file of walk(workspaceRoot, excludePatterns)) {
    if (filesScanned >= opts.maxFiles) {
      truncated = true;
      break;
    }
    if (includePatterns.length && !matchesAny(file.rel, includePatterns)) {
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(file.abs);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    let buf: Buffer;
    try {
      buf = await fs.readFile(file.abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    filesScanned++;

    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/);
    const fileLines: SearchMatchLine[] = [];
    let hitLimit = false;

    for (let i = 0; i < lines.length; i++) {
      if (fileLines.length >= opts.maxMatchesPerFile) {
        hitLimit = true;
        truncated = true;
        break;
      }
      const line = lines[i];
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line)) !== null) {
        const groupIndex = opts.wholeWord ? 1 : 0;
        const matchText = m[groupIndex];
        if (matchText === undefined || matchText === "") {
          pattern.lastIndex = (m.index ?? 0) + 1;
          continue;
        }
        let s = m.index ?? 0;
        if (opts.wholeWord) {
          // m[0] may have a leading non-word char; group 1 sits at the end of m[0].
          s += m[0].length - matchText.length;
        }
        const e = s + matchText.length;
        const trimmed = trimPreview(line, s, e);
        fileLines.push({
          line: i + 1,
          column: s + 1,
          preview: trimmed.preview,
          matchStart: trimmed.matchStart,
          matchEnd: trimmed.matchEnd,
        });
        if (fileLines.length >= opts.maxMatchesPerFile) {
          hitLimit = true;
          truncated = true;
          break;
        }
      }
      if (hitLimit) break;
    }

    if (fileLines.length > 0) {
      matches.push({ path: toPosix(file.rel), lines: fileLines });
    }
  }

  matches.sort((a, b) => a.path.localeCompare(b.path));

  return {
    matches,
    truncated,
    filesScanned,
    elapsedMs: Date.now() - started,
  };
}
