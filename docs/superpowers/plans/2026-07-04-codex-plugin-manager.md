# Codex Plugin Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a left-sidebar Codex plugin manager that can discover, install, uninstall, create, import, and remove Codex plugins such as `superpowers@openai-api-curated`.

**Architecture:** Add a user-level backend service that merges Codex CLI JSON with `~/.codex/config.toml`, `~/.codex/plugins/cache`, `~/.agents/plugins/marketplace.json`, and `~/plugins`. Expose the service through Fastify routes, then render a compact React sidebar view wired through the existing ActivityBar and Workbench sidebar switch.

**Tech Stack:** Fastify, Node `fs/promises`, Node `child_process.execFile`, `smol-toml`, Node test runner via `tsx --test`, React, Vite, existing workbench CSS.

---

## File Structure

- Create `backend/src/codex-plugins.ts`: service, typed data model, CLI runner, JSON parsing, discovery merge, personal marketplace writes, local plugin creation/import/removal.
- Create `backend/src/codex-plugins.test.ts`: Node test runner tests for helpers, discovery merge, personal marketplace creation, and safe deletion guard.
- Create `backend/src/routes/codex-plugins.ts`: Fastify routes and request parsing for the service.
- Modify `backend/package.json`: add a `test` script using `tsx --test`.
- Modify `backend/src/errors.ts`: add `codexCliNotFound`.
- Modify `backend/src/server.ts`: register Codex plugin routes.
- Create `frontend/src/workbench/CodexPluginsView.tsx`: sidebar UI, forms, grouping, actions, messages.
- Modify `frontend/src/workbench/api.ts`: types and HTTP helpers for Codex plugin endpoints.
- Modify `frontend/src/workbench/ActivityBar.tsx`: add `codex-plugins` view id, label, and icon.
- Modify `frontend/src/workbench/Workbench.tsx`: render the Codex plugin sidebar view.
- Modify `frontend/src/workbench/workbench.css`: scoped styles for `.codex-plugins`.

## Task 1: Backend Test Harness And Pure Helper Tests

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/codex-plugins.test.ts`
- Create: `backend/src/codex-plugins.ts`
- Modify: `backend/src/errors.ts`
- Test: `backend/src/codex-plugins.test.ts`

- [ ] **Step 1: Add the backend test script**

In `backend/package.json`, update `scripts` to include `test`:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -b",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "tsx --test src/**/*.test.ts"
  }
}
```

- [ ] **Step 2: Add the initial failing helper tests**

Create `backend/src/codex-plugins.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePluginName,
  parseCliJson,
} from "./codex-plugins.js";

test("normalizePluginName creates lower-case kebab-case names", () => {
  assert.equal(normalizePluginName(" My Super_Plugin!! "), "my-super-plugin");
  assert.equal(normalizePluginName("A".repeat(80)), "a".repeat(64));
});

test("normalizePluginName falls back to plugin for empty input", () => {
  assert.equal(normalizePluginName("!!!"), "plugin");
});

test("parseCliJson skips Windows code-page banner before JSON", () => {
  const parsed = parseCliJson('Active code page: 65001\\n{"installed":[],"available":[]}');
  assert.deepEqual(parsed, { installed: [], available: [] });
});

test("parseCliJson reports a useful error when stdout has no JSON", () => {
  assert.throws(
    () => parseCliJson("Active code page: 65001\\nnot json"),
    /Codex CLI did not return JSON/
  );
});
```

- [ ] **Step 3: Run the helper tests and verify RED**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: FAIL because `./codex-plugins.js` and the exported helpers do not exist.

- [ ] **Step 4: Add typed errors**

In `backend/src/errors.ts`, import is not needed. Add this entry inside the exported `errors` object near the other upstream errors:

```ts
  codexCliNotFound: () =>
    new ApiError(500, "CODEX_CLI_NOT_FOUND", "Codex CLI was not found"),
```

- [ ] **Step 5: Implement the minimal helper module**

Create `backend/src/codex-plugins.ts` with this starting implementation:

```ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { ApiError, errors } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface CodexPluginRecord {
  name: string;
  marketplace?: string;
  selector: string;
  displayName: string;
  version?: string;
  description?: string;
  status: {
    installed: boolean;
    available: boolean;
    enabled: boolean;
    cached: boolean;
    local: boolean;
  };
  source: {
    kind: "marketplace" | "personal" | "cache" | "config";
    path?: string;
  };
}

export interface CodexMarketplaceRecord {
  name: string;
  source?: string;
  path?: string;
}

export interface CodexPluginSnapshot {
  plugins: CodexPluginRecord[];
  marketplaces: CodexMarketplaceRecord[];
  warnings: string[];
  paths: {
    codexDir: string;
    codexConfig: string;
    codexPluginCache: string;
    personalMarketplace: string;
    personalPluginRoot: string;
  };
}

export interface CodexPluginManifest {
  name: string;
  version?: string;
  description?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    category?: string;
    developerName?: string;
  };
  [key: string]: unknown;
}

export interface CodexPluginPaths {
  codexDir: string;
  codexConfig: string;
  codexPluginCache: string;
  personalMarketplace: string;
  personalPluginRoot: string;
}

export interface CodexPluginServiceOptions {
  paths?: Partial<CodexPluginPaths>;
  runCli?: (args: string[]) => Promise<string>;
}

export function normalizePluginName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "plugin";
}

export function parseCliJson(text: string): unknown {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = Math.max(startObj, startArr);
  if (start < 0) throw new Error("Codex CLI did not return JSON");
  try {
    return JSON.parse(text.slice(start));
  } catch (e) {
    throw new Error(`Codex CLI JSON parse failed: ${(e as Error).message}`);
  }
}

export function defaultCodexPluginPaths(): CodexPluginPaths {
  const home = os.homedir() || ".";
  const codexDir = path.resolve(process.env.OSHEEP_CODEX_CONFIG_DIR || path.join(home, ".codex"));
  const personalMarketplace = path.resolve(
    process.env.OSHEEP_CODEX_PERSONAL_MARKETPLACE ||
      path.join(home, ".agents", "plugins", "marketplace.json")
  );
  const personalPluginRoot = path.resolve(
    process.env.OSHEEP_CODEX_PERSONAL_PLUGIN_ROOT || path.join(home, "plugins")
  );
  return {
    codexDir,
    codexConfig: path.join(codexDir, "config.toml"),
    codexPluginCache: path.join(codexDir, "plugins", "cache"),
    personalMarketplace,
    personalPluginRoot,
  };
}

export function resolveCodexPluginPaths(
  overrides: Partial<CodexPluginPaths> = {}
): CodexPluginPaths {
  return { ...defaultCodexPluginPaths(), ...overrides };
}

export async function runCodexPluginCli(args: string[]): Promise<string> {
  const bin = process.platform === "win32" ? "codex.cmd" : "codex";
  try {
    const result = await execFileAsync(bin, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === "ENOENT") throw errors.codexCliNotFound();
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new ApiError(502, "CODEX_CLI_FAILED", output || err.message);
  }
}

export async function getCodexPluginSnapshot(
  _options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(_options.paths);
  return {
    plugins: [],
    marketplaces: [],
    warnings: [],
    paths,
  };
}

void fs;
void parseToml;
```

- [ ] **Step 6: Run the helper tests and verify GREEN**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: PASS for the four helper tests.

- [ ] **Step 7: Commit Task 1**

```powershell
git add backend/package.json backend/src/errors.ts backend/src/codex-plugins.ts backend/src/codex-plugins.test.ts
git commit -m "test: add codex plugin helper coverage"
```

## Task 2: Backend Discovery Merge

**Files:**
- Modify: `backend/src/codex-plugins.test.ts`
- Modify: `backend/src/codex-plugins.ts`
- Test: `backend/src/codex-plugins.test.ts`

- [ ] **Step 1: Add failing discovery tests**

Append these tests to `backend/src/codex-plugins.test.ts`:

```ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  getCodexPluginSnapshot,
  type CodexPluginPaths,
} from "./codex-plugins.js";

async function makeFixturePaths(): Promise<CodexPluginPaths> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-plugins-"));
  return {
    codexDir: path.join(root, ".codex"),
    codexConfig: path.join(root, ".codex", "config.toml"),
    codexPluginCache: path.join(root, ".codex", "plugins", "cache"),
    personalMarketplace: path.join(root, ".agents", "plugins", "marketplace.json"),
    personalPluginRoot: path.join(root, "plugins"),
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("snapshot merges CLI, config, cache, and personal marketplace records", async () => {
  const paths = await makeFixturePaths();
  await fs.mkdir(path.dirname(paths.codexConfig), { recursive: true });
  await fs.writeFile(
    paths.codexConfig,
    '[plugins."superpowers@openai-api-curated"]\\nenabled = true\\n',
    "utf8"
  );
  await writeJson(
    path.join(
      paths.codexPluginCache,
      "openai-api-curated",
      "superpowers",
      "3fdeeb49",
      ".codex-plugin",
      "plugin.json"
    ),
    {
      name: "superpowers",
      version: "5.1.3",
      description: "Planning workflows",
      interface: { displayName: "Superpowers" },
    }
  );
  await writeJson(paths.personalMarketplace, {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: [
      {
        name: "local-tools",
        source: { source: "local", path: "./plugins/local-tools" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  await writeJson(
    path.join(paths.personalPluginRoot, "local-tools", ".codex-plugin", "plugin.json"),
    {
      name: "local-tools",
      version: "0.1.0",
      description: "Local helper plugin",
      interface: { displayName: "Local Tools" },
    }
  );

  const snapshot = await getCodexPluginSnapshot({
    paths,
    runCli: async (args) => {
      if (args.join(" ") === "plugin list --available --json") {
        return JSON.stringify({
          installed: [],
          available: [
            {
              name: "sample",
              marketplace: "debug",
              version: "1.0.0",
              description: "Sample plugin",
            },
          ],
        });
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify({
          marketplaces: [{ name: "debug", source: "local", path: "C:/debug" }],
        });
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  const selectors = snapshot.plugins.map((p) => p.selector).sort();
  assert.deepEqual(selectors, [
    "local-tools@personal",
    "sample@debug",
    "superpowers@openai-api-curated",
  ]);
  const superpowers = snapshot.plugins.find((p) => p.selector === "superpowers@openai-api-curated");
  assert.equal(superpowers?.displayName, "Superpowers");
  assert.equal(superpowers?.status.enabled, true);
  assert.equal(superpowers?.status.cached, true);
  assert.equal(superpowers?.status.installed, true);
  const localTools = snapshot.plugins.find((p) => p.selector === "local-tools@personal");
  assert.equal(localTools?.status.local, true);
  assert.equal(localTools?.status.available, true);
  assert.equal(snapshot.marketplaces[0]?.name, "debug");
});
```

- [ ] **Step 2: Run discovery tests and verify RED**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: FAIL because `getCodexPluginSnapshot` returns empty arrays.

- [ ] **Step 3: Replace the backend service with discovery implementation**

In `backend/src/codex-plugins.ts`, replace the minimal `getCodexPluginSnapshot` implementation and remove `void fs; void parseToml;`. Add these helpers below `runCodexPluginCli`:

```ts
interface MergeRecord {
  name: string;
  marketplace?: string;
  selector?: string;
  displayName?: string;
  version?: string;
  description?: string;
  installed?: boolean;
  available?: boolean;
  enabled?: boolean;
  cached?: boolean;
  local?: boolean;
  sourceKind: CodexPluginRecord["source"]["kind"];
  sourcePath?: string;
}

interface PersonalMarketplaceFile {
  name?: unknown;
  interface?: { displayName?: unknown };
  plugins?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function selectorFor(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name;
}

function splitSelector(selector: string): { name: string; marketplace?: string } {
  const at = selector.lastIndexOf("@");
  if (at <= 0 || at === selector.length - 1) return { name: selector };
  return { name: selector.slice(0, at), marketplace: selector.slice(at + 1) };
}

function emptyStatus(): CodexPluginRecord["status"] {
  return {
    installed: false,
    available: false,
    enabled: false,
    cached: false,
    local: false,
  };
}

function mergePlugin(map: Map<string, CodexPluginRecord>, input: MergeRecord): void {
  const rawSelector = input.selector || selectorFor(input.name, input.marketplace);
  const split = splitSelector(rawSelector);
  const name = input.name || split.name;
  const marketplace = input.marketplace || split.marketplace;
  const selector = selectorFor(name, marketplace);
  const prev = map.get(selector);
  const status = { ...(prev?.status ?? emptyStatus()) };
  status.installed = status.installed || !!input.installed || !!input.enabled || !!input.cached;
  status.available = status.available || !!input.available;
  status.enabled = status.enabled || !!input.enabled;
  status.cached = status.cached || !!input.cached;
  status.local = status.local || !!input.local;
  map.set(selector, {
    name,
    marketplace,
    selector,
    displayName: input.displayName || prev?.displayName || name,
    version: input.version || prev?.version,
    description: input.description || prev?.description,
    status,
    source: {
      kind: input.sourceKind || prev?.source.kind || "config",
      path: input.sourcePath || prev?.source.path,
    },
  });
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function manifestMetadata(manifest: unknown): Pick<
  MergeRecord,
  "displayName" | "version" | "description"
> {
  const obj = objectValue(manifest);
  const ui = objectValue(obj?.interface);
  return {
    displayName: stringValue(ui?.displayName) || stringValue(obj?.name),
    version: stringValue(obj?.version) || undefined,
    description:
      stringValue(ui?.shortDescription) ||
      stringValue(obj?.description) ||
      undefined,
  };
}

function normalizeCliPlugin(value: unknown, fallbackStatus: "installed" | "available"): MergeRecord | null {
  const obj = objectValue(value);
  if (!obj) return null;
  const selector = stringValue(obj.selector);
  const split = selector ? splitSelector(selector) : null;
  const name = stringValue(obj.name) || split?.name || "";
  if (!name) return null;
  const marketplace =
    stringValue(obj.marketplace) ||
    stringValue(obj.marketplaceName) ||
    split?.marketplace ||
    undefined;
  return {
    name,
    marketplace,
    selector: selector || undefined,
    displayName: stringValue(obj.displayName) || stringValue(obj.title) || name,
    version: stringValue(obj.version) || undefined,
    description: stringValue(obj.description) || undefined,
    installed: fallbackStatus === "installed" || obj.installed === true,
    available: fallbackStatus === "available" || obj.available === true,
    enabled: obj.enabled === true,
    sourceKind: "marketplace",
  };
}

async function discoverCliPlugins(
  runCli: (args: string[]) => Promise<string>,
  warnings: string[]
): Promise<{ records: MergeRecord[]; marketplaces: CodexMarketplaceRecord[] }> {
  const records: MergeRecord[] = [];
  const marketplaces: CodexMarketplaceRecord[] = [];
  try {
    const parsed = objectValue(parseCliJson(await runCli(["plugin", "list", "--available", "--json"])));
    for (const item of Array.isArray(parsed?.installed) ? parsed.installed : []) {
      const record = normalizeCliPlugin(item, "installed");
      if (record) records.push(record);
    }
    for (const item of Array.isArray(parsed?.available) ? parsed.available : []) {
      const record = normalizeCliPlugin(item, "available");
      if (record) records.push(record);
    }
  } catch (e) {
    warnings.push(`Codex plugin list failed: ${(e as Error).message}`);
  }

  try {
    const parsed = objectValue(parseCliJson(await runCli(["plugin", "marketplace", "list", "--json"])));
    for (const item of Array.isArray(parsed?.marketplaces) ? parsed.marketplaces : []) {
      const obj = objectValue(item);
      const name = stringValue(obj?.name);
      if (!name) continue;
      marketplaces.push({
        name,
        source: stringValue(obj?.source) || undefined,
        path: stringValue(obj?.path) || undefined,
      });
    }
  } catch (e) {
    warnings.push(`Codex marketplace list failed: ${(e as Error).message}`);
  }
  return { records, marketplaces };
}

async function discoverConfigPlugins(configPath: string, warnings: string[]): Promise<MergeRecord[]> {
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = parseToml(text) as Record<string, unknown>;
    const plugins = objectValue(parsed.plugins);
    const out: MergeRecord[] = [];
    for (const [selector, value] of Object.entries(plugins ?? {})) {
      const pluginConfig = objectValue(value);
      const split = splitSelector(selector);
      out.push({
        name: split.name,
        marketplace: split.marketplace,
        selector,
        enabled: pluginConfig?.enabled !== false,
        installed: true,
        sourceKind: "config",
        sourcePath: configPath,
      });
    }
    return out;
  } catch (e) {
    warnings.push(`Codex config parse failed: ${(e as Error).message}`);
    return [];
  }
}

async function discoverCachePlugins(cacheRoot: string): Promise<MergeRecord[]> {
  const records: MergeRecord[] = [];
  let marketplaces: string[];
  try {
    marketplaces = await fs.readdir(cacheRoot);
  } catch {
    return records;
  }
  for (const marketplace of marketplaces) {
    const marketplaceDir = path.join(cacheRoot, marketplace);
    const pluginNames = await fs.readdir(marketplaceDir).catch(() => []);
    for (const pluginName of pluginNames) {
      const pluginDir = path.join(marketplaceDir, pluginName);
      const versions = await fs.readdir(pluginDir).catch(() => []);
      for (const versionDir of versions) {
        const root = path.join(pluginDir, versionDir);
        const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
        const manifest = await readJsonFile(manifestPath);
        if (!manifest) continue;
        records.push({
          name: pluginName,
          marketplace,
          cached: true,
          installed: true,
          sourceKind: "cache",
          sourcePath: root,
          ...manifestMetadata(manifest),
        });
      }
    }
  }
  return records;
}

function resolveMarketplaceSourcePath(marketplacePath: string, sourcePath: string): string {
  if (path.isAbsolute(sourcePath)) return path.resolve(sourcePath);
  return path.resolve(path.dirname(marketplacePath), sourcePath);
}

async function discoverPersonalMarketplacePlugins(marketplacePath: string): Promise<MergeRecord[]> {
  const parsed = objectValue(await readJsonFile(marketplacePath)) as PersonalMarketplaceFile | null;
  if (!parsed || !Array.isArray(parsed.plugins)) return [];
  const marketName = stringValue(parsed.name) || "personal";
  const records: MergeRecord[] = [];
  for (const entry of parsed.plugins) {
    const obj = objectValue(entry);
    const name = stringValue(obj?.name);
    const source = objectValue(obj?.source);
    const sourcePath = stringValue(source?.path);
    if (!name || !sourcePath) continue;
    const absPath = resolveMarketplaceSourcePath(marketplacePath, sourcePath);
    const manifest = await readJsonFile(path.join(absPath, ".codex-plugin", "plugin.json"));
    records.push({
      name,
      marketplace: marketName,
      available: true,
      local: true,
      sourceKind: "personal",
      sourcePath: absPath,
      ...manifestMetadata(manifest ?? { name }),
    });
  }
  return records;
}

export async function getCodexPluginSnapshot(
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  const runCli = options.runCli ?? runCodexPluginCli;
  const warnings: string[] = [];
  const map = new Map<string, CodexPluginRecord>();

  const cli = await discoverCliPlugins(runCli, warnings);
  for (const record of cli.records) mergePlugin(map, record);
  for (const record of await discoverConfigPlugins(paths.codexConfig, warnings)) mergePlugin(map, record);
  for (const record of await discoverCachePlugins(paths.codexPluginCache)) mergePlugin(map, record);
  for (const record of await discoverPersonalMarketplacePlugins(paths.personalMarketplace)) {
    mergePlugin(map, record);
  }

  const plugins = [...map.values()].sort((a, b) => {
    const groupA = a.status.installed ? 0 : a.status.local ? 1 : 2;
    const groupB = b.status.installed ? 0 : b.status.local ? 1 : 2;
    if (groupA !== groupB) return groupA - groupB;
    return a.displayName.localeCompare(b.displayName);
  });

  return {
    plugins,
    marketplaces: cli.marketplaces.sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
    paths,
  };
}
```

- [ ] **Step 4: Run discovery tests and verify GREEN**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: PASS for helper and discovery tests.

- [ ] **Step 5: Commit Task 2**

```powershell
git add backend/src/codex-plugins.ts backend/src/codex-plugins.test.ts
git commit -m "feat: discover codex plugins"
```

## Task 3: Local Plugin Mutations And CLI Actions

**Files:**
- Modify: `backend/src/codex-plugins.test.ts`
- Modify: `backend/src/codex-plugins.ts`
- Test: `backend/src/codex-plugins.test.ts`

- [ ] **Step 1: Add failing mutation tests**

Append these tests to `backend/src/codex-plugins.test.ts`:

```ts
import {
  addCodexMarketplace,
  createLocalCodexPlugin,
  importLocalCodexPlugin,
  installCodexPlugin,
  removeLocalCodexPlugin,
  uninstallCodexPlugin,
} from "./codex-plugins.js";

test("createLocalCodexPlugin writes manifest and initial personal marketplace", async () => {
  const paths = await makeFixturePaths();
  await createLocalCodexPlugin(
    { name: "My Tools", displayName: "My Tools", description: "Useful local commands" },
    { paths, runCli: async () => "{}" }
  );
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(paths.personalPluginRoot, "my-tools", ".codex-plugin", "plugin.json"),
      "utf8"
    )
  ) as { name: string; interface: { displayName: string } };
  assert.equal(manifest.name, "my-tools");
  assert.equal(manifest.interface.displayName, "My Tools");
  const marketplace = JSON.parse(await fs.readFile(paths.personalMarketplace, "utf8")) as {
    name: string;
    plugins: Array<{ name: string; source: { path: string } }>;
  };
  assert.equal(marketplace.name, "personal");
  assert.equal(marketplace.plugins[0]?.name, "my-tools");
  assert.equal(marketplace.plugins[0]?.source.path, "./plugins/my-tools");
});

test("importLocalCodexPlugin adds existing manifest to personal marketplace", async () => {
  const paths = await makeFixturePaths();
  const pluginPath = path.join(paths.personalPluginRoot, "imported");
  await writeJson(path.join(pluginPath, ".codex-plugin", "plugin.json"), {
    name: "imported",
    version: "1.2.3",
    description: "Imported plugin",
    interface: { displayName: "Imported" },
  });
  await importLocalCodexPlugin({ path: pluginPath }, { paths, runCli: async () => "{}" });
  const snapshot = await getCodexPluginSnapshot({ paths, runCli: async () => '{"installed":[],"available":[]}' });
  assert.equal(snapshot.plugins[0]?.selector, "imported@personal");
  assert.equal(snapshot.plugins[0]?.displayName, "Imported");
});

test("removeLocalCodexPlugin refuses to delete source outside the personal plugin root", async () => {
  const paths = await makeFixturePaths();
  const outside = path.join(path.dirname(paths.personalPluginRoot), "outside-plugin");
  await writeJson(path.join(outside, ".codex-plugin", "plugin.json"), { name: "outside-plugin" });
  await fs.mkdir(path.dirname(paths.personalMarketplace), { recursive: true });
  await fs.writeFile(
    paths.personalMarketplace,
    JSON.stringify({
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [
        {
          name: "outside-plugin",
          source: { source: "local", path: "../outside-plugin" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }),
    "utf8"
  );
  await assert.rejects(
    () => removeLocalCodexPlugin("outside-plugin", true, { paths, runCli: async () => "{}" }),
    /Refusing to delete source outside personal plugin root/
  );
});

test("install, uninstall, and marketplace add call Codex CLI with JSON flags", async () => {
  const calls: string[][] = [];
  const runCli = async (args: string[]) => {
    calls.push(args);
    return '{"ok":true}';
  };
  await installCodexPlugin("sample@debug", { runCli });
  await uninstallCodexPlugin("sample@debug", { runCli });
  await addCodexMarketplace("C:/plugins/debug", { runCli });
  assert.deepEqual(calls, [
    ["plugin", "add", "sample@debug", "--json"],
    ["plugin", "remove", "sample@debug", "--json"],
    ["plugin", "marketplace", "add", "C:/plugins/debug", "--json"],
  ]);
});
```

- [ ] **Step 2: Run mutation tests and verify RED**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: FAIL because mutation functions are not exported.

- [ ] **Step 3: Add mutation implementation**

Append these exports to `backend/src/codex-plugins.ts`:

```ts
export interface CreateLocalCodexPluginInput {
  name: string;
  displayName?: string;
  description?: string;
}

export interface ImportLocalCodexPluginInput {
  path: string;
}

function marketplaceEntry(pluginName: string): Record<string, unknown> {
  return {
    name: pluginName,
    source: {
      source: "local",
      path: `./plugins/${pluginName}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };
}

function defaultMarketplace(): Record<string, unknown> {
  return {
    name: "personal",
    interface: {
      displayName: "Personal",
    },
    plugins: [],
  };
}

async function readMarketplaceFile(filePath: string): Promise<Record<string, unknown>> {
  const existing = objectValue(await readJsonFile(filePath));
  if (!existing) return defaultMarketplace();
  if (!Array.isArray(existing.plugins)) existing.plugins = [];
  if (!stringValue(existing.name)) existing.name = "personal";
  if (!objectValue(existing.interface)) existing.interface = { displayName: "Personal" };
  return existing;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\\n", "utf8");
  await fs.rename(temp, filePath);
}

async function upsertPersonalMarketplaceEntry(
  paths: CodexPluginPaths,
  pluginName: string,
  sourcePath = `./plugins/${pluginName}`
): Promise<void> {
  const marketplace = await readMarketplaceFile(paths.personalMarketplace);
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const nextEntry = {
    ...marketplaceEntry(pluginName),
    source: {
      source: "local",
      path: sourcePath,
    },
  };
  const index = plugins.findIndex((entry) => objectValue(entry)?.name === pluginName);
  if (index >= 0) plugins[index] = nextEntry;
  else plugins.push(nextEntry);
  marketplace.plugins = plugins;
  await writeJsonAtomic(paths.personalMarketplace, marketplace);
}

function defaultManifest(input: CreateLocalCodexPluginInput, pluginName: string): CodexPluginManifest {
  const displayName = input.displayName?.trim() || input.name.trim() || pluginName;
  const description = input.description?.trim() || `Personal Codex plugin ${displayName}`;
  return {
    name: pluginName,
    version: "0.1.0",
    description,
    author: {
      name: "Personal",
    },
    license: "UNLICENSED",
    keywords: ["codex", "personal"],
    interface: {
      displayName,
      shortDescription: description,
      developerName: "Personal",
      category: "Productivity",
      capabilities: ["Interactive"],
    },
  };
}

export async function createLocalCodexPlugin(
  input: CreateLocalCodexPluginInput,
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  const pluginName = normalizePluginName(input.name);
  const pluginRoot = path.join(paths.personalPluginRoot, pluginName);
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  await writeJsonAtomic(manifestPath, defaultManifest(input, pluginName));
  await upsertPersonalMarketplaceEntry(paths, pluginName);
  return await getCodexPluginSnapshot(options);
}

export async function importLocalCodexPlugin(
  input: ImportLocalCodexPluginInput,
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  const pluginRoot = path.resolve(input.path);
  const manifest = objectValue(await readJsonFile(path.join(pluginRoot, ".codex-plugin", "plugin.json")));
  const pluginName = normalizePluginName(stringValue(manifest?.name));
  if (!manifest || !stringValue(manifest.name)) {
    throw errors.invalidQuery("Codex plugin manifest with a name is required");
  }
  const relative = path.relative(path.dirname(paths.personalMarketplace), pluginRoot).replace(/\\\\/g, "/");
  const sourcePath = relative.startsWith(".") ? relative : `./${relative}`;
  await upsertPersonalMarketplaceEntry(paths, pluginName, sourcePath);
  return await getCodexPluginSnapshot(options);
}

export async function removeLocalCodexPlugin(
  name: string,
  deleteSource: boolean,
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  const pluginName = normalizePluginName(name);
  const marketplace = await readMarketplaceFile(paths.personalMarketplace);
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const entry = plugins.find((item) => objectValue(item)?.name === pluginName);
  const entrySource = objectValue(objectValue(entry)?.source);
  const sourcePath = stringValue(entrySource?.path);
  marketplace.plugins = plugins.filter((item) => objectValue(item)?.name !== pluginName);
  await writeJsonAtomic(paths.personalMarketplace, marketplace);

  if (deleteSource) {
    const resolved = sourcePath
      ? resolveMarketplaceSourcePath(paths.personalMarketplace, sourcePath)
      : path.join(paths.personalPluginRoot, pluginName);
    const root = path.resolve(paths.personalPluginRoot);
    const finalPath = path.resolve(resolved);
    const expected = path.join(root, pluginName);
    if (finalPath !== expected) {
      throw errors.invalidQuery("Refusing to delete source outside personal plugin root");
    }
    await fs.rm(finalPath, { recursive: true, force: true });
  }

  return await getCodexPluginSnapshot(options);
}

export async function installCodexPlugin(
  selector: string,
  options: CodexPluginServiceOptions = {}
): Promise<unknown> {
  const runCli = options.runCli ?? runCodexPluginCli;
  return parseCliJson(await runCli(["plugin", "add", selector, "--json"]));
}

export async function uninstallCodexPlugin(
  selector: string,
  options: CodexPluginServiceOptions = {}
): Promise<unknown> {
  const runCli = options.runCli ?? runCodexPluginCli;
  return parseCliJson(await runCli(["plugin", "remove", selector, "--json"]));
}

export async function addCodexMarketplace(
  source: string,
  options: CodexPluginServiceOptions = {}
): Promise<unknown> {
  const runCli = options.runCli ?? runCodexPluginCli;
  return parseCliJson(await runCli(["plugin", "marketplace", "add", source, "--json"]));
}
```

- [ ] **Step 4: Run mutation tests and verify GREEN**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: PASS for helper, discovery, and mutation tests.

- [ ] **Step 5: Commit Task 3**

```powershell
git add backend/src/codex-plugins.ts backend/src/codex-plugins.test.ts
git commit -m "feat: manage local codex plugins"
```

## Task 4: Backend Routes

**Files:**
- Create: `backend/src/routes/codex-plugins.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/codex-plugins.test.ts`
- Test: `backend/src/codex-plugins.test.ts`

- [ ] **Step 1: Add a route shape test for request parsing helpers**

Append this test to `backend/src/codex-plugins.test.ts`:

```ts
import {
  parseDeleteSourceFlag,
  parseRequiredStringField,
} from "./routes/codex-plugins.js";

test("route helpers parse required strings and deleteSource flags", () => {
  assert.equal(parseRequiredStringField({ selector: " sample@debug " }, "selector"), "sample@debug");
  assert.equal(parseDeleteSourceFlag({ deleteSource: "true" }), true);
  assert.equal(parseDeleteSourceFlag({ deleteSource: "false" }), false);
  assert.throws(() => parseRequiredStringField({}, "selector"), /selector is required/);
});
```

- [ ] **Step 2: Run route helper test and verify RED**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: FAIL because `routes/codex-plugins.js` does not exist.

- [ ] **Step 3: Create the Codex plugin routes**

Create `backend/src/routes/codex-plugins.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";
import {
  addCodexMarketplace,
  createLocalCodexPlugin,
  getCodexPluginSnapshot,
  importLocalCodexPlugin,
  installCodexPlugin,
  removeLocalCodexPlugin,
  uninstallCodexPlugin,
} from "../codex-plugins.js";

export function parseRequiredStringField(
  body: unknown,
  field: string
): string {
  const obj = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const value = obj[field];
  if (typeof value !== "string" || !value.trim()) {
    throw errors.invalidQuery(`${field} is required`);
  }
  return value.trim();
}

export function parseDeleteSourceFlag(query: unknown): boolean {
  const obj = query && typeof query === "object" && !Array.isArray(query)
    ? (query as Record<string, unknown>)
    : {};
  return obj.deleteSource === true || obj.deleteSource === "true";
}

export async function registerCodexPluginRoutes(app: FastifyInstance) {
  app.get("/api/codex-plugins", async () => {
    return await getCodexPluginSnapshot();
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/install", async (req) => {
    const selector = parseRequiredStringField(req.body, "selector");
    const result = await installCodexPlugin(selector);
    return { ok: true, result, snapshot: await getCodexPluginSnapshot() };
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/uninstall", async (req) => {
    const selector = parseRequiredStringField(req.body, "selector");
    const result = await uninstallCodexPlugin(selector);
    return { ok: true, result, snapshot: await getCodexPluginSnapshot() };
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/local", async (req) => {
    const obj = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
    const name = parseRequiredStringField(obj, "name");
    const displayName = typeof obj.displayName === "string" ? obj.displayName : undefined;
    const description = typeof obj.description === "string" ? obj.description : undefined;
    return await createLocalCodexPlugin({ name, displayName, description });
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/import-local", async (req) => {
    const pluginPath = parseRequiredStringField(req.body, "path");
    return await importLocalCodexPlugin({ path: pluginPath });
  });

  app.delete<{
    Params: { name: string };
    Querystring: { deleteSource?: string | boolean };
  }>("/api/codex-plugins/local/:name", async (req) => {
    return await removeLocalCodexPlugin(
      req.params.name,
      parseDeleteSourceFlag(req.query)
    );
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/marketplaces", async (req) => {
    const source = parseRequiredStringField(req.body, "source");
    const result = await addCodexMarketplace(source);
    return { ok: true, result, snapshot: await getCodexPluginSnapshot() };
  });
}
```

- [ ] **Step 4: Register the route module**

In `backend/src/server.ts`, add the import near the other route imports:

```ts
import { registerCodexPluginRoutes } from "./routes/codex-plugins.js";
```

Then register it after AI settings or MCP routes:

```ts
  await registerCodexPluginRoutes(app);
```

- [ ] **Step 5: Run route helper tests and backend build**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: PASS.

Run from `backend/`:

```powershell
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit Task 4**

```powershell
git add backend/src/routes/codex-plugins.ts backend/src/server.ts backend/src/codex-plugins.test.ts
git commit -m "feat: add codex plugin api routes"
```

## Task 5: Frontend API Client

**Files:**
- Modify: `frontend/src/workbench/api.ts`
- Test: `frontend`

- [ ] **Step 1: Add Codex plugin API types and helpers**

Append this section before the Workflows section in `frontend/src/workbench/api.ts`:

```ts
// Codex Plugins

export interface CodexPluginRecord {
  name: string;
  marketplace?: string;
  selector: string;
  displayName: string;
  version?: string;
  description?: string;
  status: {
    installed: boolean;
    available: boolean;
    enabled: boolean;
    cached: boolean;
    local: boolean;
  };
  source: {
    kind: "marketplace" | "personal" | "cache" | "config";
    path?: string;
  };
}

export interface CodexMarketplaceRecord {
  name: string;
  source?: string;
  path?: string;
}

export interface CodexPluginSnapshot {
  plugins: CodexPluginRecord[];
  marketplaces: CodexMarketplaceRecord[];
  warnings: string[];
  paths: {
    codexDir: string;
    codexConfig: string;
    codexPluginCache: string;
    personalMarketplace: string;
    personalPluginRoot: string;
  };
}

export async function getCodexPlugins(): Promise<CodexPluginSnapshot> {
  return await http.get("/api/codex-plugins");
}

export async function installCodexPluginApi(selector: string): Promise<CodexPluginSnapshot> {
  const result = await http.post<{ snapshot: CodexPluginSnapshot }>(
    "/api/codex-plugins/install",
    { selector }
  );
  return result.snapshot;
}

export async function uninstallCodexPluginApi(selector: string): Promise<CodexPluginSnapshot> {
  const result = await http.post<{ snapshot: CodexPluginSnapshot }>(
    "/api/codex-plugins/uninstall",
    { selector }
  );
  return result.snapshot;
}

export async function createLocalCodexPluginApi(input: {
  name: string;
  displayName?: string;
  description?: string;
}): Promise<CodexPluginSnapshot> {
  return await http.post("/api/codex-plugins/local", input);
}

export async function importLocalCodexPluginApi(path: string): Promise<CodexPluginSnapshot> {
  return await http.post("/api/codex-plugins/import-local", { path });
}

export async function removeLocalCodexPluginApi(
  name: string,
  deleteSource: boolean
): Promise<CodexPluginSnapshot> {
  const qs = new URLSearchParams({ deleteSource: deleteSource ? "true" : "false" }).toString();
  return await http.delete(`/api/codex-plugins/local/${encodeURIComponent(name)}?${qs}`);
}

export async function addCodexMarketplaceApi(source: string): Promise<CodexPluginSnapshot> {
  const result = await http.post<{ snapshot: CodexPluginSnapshot }>(
    "/api/codex-plugins/marketplaces",
    { source }
  );
  return result.snapshot;
}
```

- [ ] **Step 2: Run frontend build and verify GREEN**

Run from `frontend/`:

```powershell
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Commit Task 5**

```powershell
git add frontend/src/workbench/api.ts
git commit -m "feat: add codex plugin api client"
```

## Task 6: Frontend Sidebar Component

**Files:**
- Create: `frontend/src/workbench/CodexPluginsView.tsx`
- Test: `frontend`

- [ ] **Step 1: Create the CodexPluginsView component**

Create `frontend/src/workbench/CodexPluginsView.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  addCodexMarketplaceApi,
  createLocalCodexPluginApi,
  getCodexPlugins,
  importLocalCodexPluginApi,
  installCodexPluginApi,
  removeLocalCodexPluginApi,
  uninstallCodexPluginApi,
  type CodexPluginRecord,
  type CodexPluginSnapshot,
} from "./api";

type DialogMode = "new" | "import" | "marketplace" | null;

export function CodexPluginsView() {
  const [snapshot, setSnapshot] = useState<CodexPluginSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [path, setPath] = useState("");
  const [source, setSource] = useState("");

  useEffect(() => {
    void refresh();
  }, []);

  const groups = useMemo(() => groupPlugins(snapshot?.plugins ?? []), [snapshot]);

  async function refresh() {
    await run(async () => {
      setSnapshot(await getCodexPlugins());
    }, false);
  }

  async function run(task: () => Promise<void>, done = true) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await task();
      if (done) {
        setMessage("Done. Start a new Codex session for changed plugins to take effect.");
        window.setTimeout(() => setMessage(null), 4000);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function resetDialog(next: DialogMode) {
    setDialog(next);
    setName("");
    setDisplayName("");
    setDescription("");
    setPath("");
    setSource("");
    setError(null);
    setMessage(null);
  }

  function install(plugin: CodexPluginRecord) {
    void run(async () => {
      setSnapshot(await installCodexPluginApi(plugin.selector));
    });
  }

  function uninstall(plugin: CodexPluginRecord) {
    if (!confirm(`Uninstall ${plugin.displayName}?`)) return;
    void run(async () => {
      setSnapshot(await uninstallCodexPluginApi(plugin.selector));
    });
  }

  function removeLocal(plugin: CodexPluginRecord, deleteSource: boolean) {
    const suffix = deleteSource ? " and delete its source directory" : "";
    if (!confirm(`Remove ${plugin.displayName} from the personal marketplace${suffix}?`)) return;
    void run(async () => {
      setSnapshot(await removeLocalCodexPluginApi(plugin.name, deleteSource));
    });
  }

  function submitDialog() {
    if (dialog === "new") {
      void run(async () => {
        setSnapshot(await createLocalCodexPluginApi({ name, displayName, description }));
        resetDialog(null);
      });
    } else if (dialog === "import") {
      void run(async () => {
        setSnapshot(await importLocalCodexPluginApi(path));
        resetDialog(null);
      });
    } else if (dialog === "marketplace") {
      void run(async () => {
        setSnapshot(await addCodexMarketplaceApi(source));
        resetDialog(null);
      });
    }
  }

  return (
    <div className="codex-plugins side-view">
      <div className="side-view__header codex-plugins__header">
        <span className="side-view__title">Codex Plugins</span>
        <button className="icon-btn" title="Refresh" onClick={() => void refresh()} disabled={busy}>
          <RefreshIcon />
        </button>
      </div>

      <div className="codex-plugins__toolbar">
        <button className="primary-btn" onClick={() => resetDialog("new")} disabled={busy}>
          New
        </button>
        <button className="tb-btn" onClick={() => resetDialog("import")} disabled={busy}>
          Import
        </button>
        <button className="tb-btn" onClick={() => resetDialog("marketplace")} disabled={busy}>
          Source
        </button>
      </div>

      {snapshot && (
        <div className="codex-plugins__path" title={snapshot.paths.personalMarketplace}>
          {snapshot.paths.personalMarketplace}
        </div>
      )}

      {error && <div className="codex-plugins__banner codex-plugins__banner--error">{error}</div>}
      {message && <div className="codex-plugins__banner codex-plugins__banner--success">{message}</div>}
      {snapshot?.warnings.map((warning) => (
        <div key={warning} className="codex-plugins__banner codex-plugins__banner--warn">
          {warning}
        </div>
      ))}

      {dialog && (
        <div className="codex-plugins__form">
          {dialog === "new" && (
            <>
              <input className="settings-view__input codex-plugins__input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Plugin name" />
              <input className="settings-view__input codex-plugins__input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" />
              <textarea className="codex-plugins__textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" />
            </>
          )}
          {dialog === "import" && (
            <input className="settings-view__input codex-plugins__input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Existing plugin path" />
          )}
          {dialog === "marketplace" && (
            <input className="settings-view__input codex-plugins__input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Marketplace source" />
          )}
          <div className="codex-plugins__form-actions">
            <button className="primary-btn" onClick={submitDialog} disabled={busy}>
              Save
            </button>
            <button className="tb-btn" onClick={() => resetDialog(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="codex-plugins__list">
        <PluginGroup title="Installed" plugins={groups.installed} onInstall={install} onUninstall={uninstall} onRemoveLocal={removeLocal} />
        <PluginGroup title="Available" plugins={groups.available} onInstall={install} onUninstall={uninstall} onRemoveLocal={removeLocal} />
        <PluginGroup title="Local" plugins={groups.local} onInstall={install} onUninstall={uninstall} onRemoveLocal={removeLocal} />
        {!snapshot && <div className="codex-plugins__empty">Loading...</div>}
      </div>
    </div>
  );
}

function groupPlugins(plugins: CodexPluginRecord[]) {
  const installed = plugins.filter((p) => p.status.installed || p.status.enabled || p.status.cached);
  const local = plugins.filter((p) => p.status.local);
  const available = plugins.filter((p) => p.status.available && !installed.some((i) => i.selector === p.selector));
  return { installed, available, local };
}

function PluginGroup({
  title,
  plugins,
  onInstall,
  onUninstall,
  onRemoveLocal,
}: {
  title: string;
  plugins: CodexPluginRecord[];
  onInstall: (plugin: CodexPluginRecord) => void;
  onUninstall: (plugin: CodexPluginRecord) => void;
  onRemoveLocal: (plugin: CodexPluginRecord, deleteSource: boolean) => void;
}) {
  return (
    <section className="codex-plugins__group">
      <div className="codex-plugins__group-title">
        <span>{title}</span>
        <span>{plugins.length}</span>
      </div>
      {plugins.length === 0 ? (
        <div className="codex-plugins__empty">None</div>
      ) : (
        plugins.map((plugin) => (
          <PluginCard
            key={`${title}:${plugin.selector}`}
            plugin={plugin}
            onInstall={() => onInstall(plugin)}
            onUninstall={() => onUninstall(plugin)}
            onRemoveEntry={() => onRemoveLocal(plugin, false)}
            onDeleteSource={() => onRemoveLocal(plugin, true)}
          />
        ))
      )}
    </section>
  );
}

function PluginCard({
  plugin,
  onInstall,
  onUninstall,
  onRemoveEntry,
  onDeleteSource,
}: {
  plugin: CodexPluginRecord;
  onInstall: () => void;
  onUninstall: () => void;
  onRemoveEntry: () => void;
  onDeleteSource: () => void;
}) {
  const canInstall = plugin.status.available || plugin.status.local;
  const canUninstall = plugin.status.installed || plugin.status.enabled || plugin.status.cached;
  return (
    <div className="codex-plugins__card">
      <div className="codex-plugins__card-main">
        <div className="codex-plugins__avatar">{plugin.displayName.slice(0, 1).toUpperCase()}</div>
        <div className="codex-plugins__meta">
          <div className="codex-plugins__name">{plugin.displayName}</div>
          <div className="codex-plugins__selector">{plugin.selector}</div>
          {plugin.description && <div className="codex-plugins__desc">{plugin.description}</div>}
          {plugin.source.path && <div className="codex-plugins__source" title={plugin.source.path}>{plugin.source.path}</div>}
          <div className="codex-plugins__badges">
            {plugin.version && <span>{plugin.version}</span>}
            {plugin.status.installed && <span>installed</span>}
            {plugin.status.enabled && <span>enabled</span>}
            {plugin.status.cached && <span>cached</span>}
            {plugin.status.local && <span>local</span>}
          </div>
        </div>
      </div>
      <div className="codex-plugins__actions">
        {canInstall && !canUninstall && <button className="tb-btn" onClick={onInstall}>Install</button>}
        {canUninstall && <button className="tb-btn" onClick={onUninstall}>Uninstall</button>}
        {plugin.status.local && <button className="tb-btn" onClick={onRemoveEntry}>Remove</button>}
        {plugin.status.local && <button className="tb-btn codex-plugins__danger" onClick={onDeleteSource}>Delete</button>}
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 3v4H9" />
      <path d="M3 13V9h4" />
      <path d="M12.2 6A4.5 4.5 0 0 0 4.5 4.8L3 6" />
      <path d="M3.8 10A4.5 4.5 0 0 0 11.5 11.2L13 10" />
    </svg>
  );
}
```

- [ ] **Step 2: Run frontend build and verify RED or GREEN**

Run from `frontend/`:

```powershell
npm run build
```

Expected: PASS if all imported API helpers exist. If TypeScript reports unused symbols or missing names, fix only this new component and rerun until PASS.

- [ ] **Step 3: Commit Task 6**

```powershell
git add frontend/src/workbench/CodexPluginsView.tsx
git commit -m "feat: add codex plugin sidebar view"
```

## Task 7: Wire Sidebar Navigation And Styles

**Files:**
- Modify: `frontend/src/workbench/ActivityBar.tsx`
- Modify: `frontend/src/workbench/Workbench.tsx`
- Modify: `frontend/src/workbench/workbench.css`
- Test: `frontend`

- [ ] **Step 1: Add the ActivityBar view id and item**

In `frontend/src/workbench/ActivityBar.tsx`, change the `ViewId` union:

```ts
export type ViewId = "explorer" | "search" | "git" | "ai-settings" | "codex-plugins";
```

Add this item to `ITEMS` after `ai-settings`:

```tsx
  { id: "codex-plugins", label: "Codex Plugins", icon: <CodexPluginsIcon /> },
```

Add this icon function near the other icon functions:

```tsx
function CodexPluginsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 4h8l4 4v8l-4 4H8l-4-4V8l4-4z" />
      <path d="M9 9h6v6H9z" />
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
    </svg>
  );
}
```

- [ ] **Step 2: Render the view from Workbench**

In `frontend/src/workbench/Workbench.tsx`, add the import:

```ts
import { CodexPluginsView } from "./CodexPluginsView";
```

Inside the left sidebar render branch, after the AI settings branch, add:

```tsx
            {activeView === "codex-plugins" && <CodexPluginsView />}
```

- [ ] **Step 3: Add scoped CSS**

Append these styles to `frontend/src/workbench/workbench.css`:

```css
.codex-plugins {
  min-width: 0;
}

.codex-plugins__header {
  gap: 8px;
}

.codex-plugins__toolbar {
  display: flex;
  gap: 6px;
  padding: 10px;
  border-bottom: 1px solid var(--border);
}

.codex-plugins__toolbar .primary-btn,
.codex-plugins__toolbar .tb-btn {
  height: 28px;
  min-width: 0;
  padding: 0 10px;
  font-size: 12px;
}

.codex-plugins__path,
.codex-plugins__source,
.codex-plugins__selector,
.codex-plugins__desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-plugins__path {
  padding: 8px 10px;
  color: var(--muted);
  font-size: 11px;
  border-bottom: 1px solid var(--border);
}

.codex-plugins__banner {
  margin: 8px 10px 0;
  padding: 7px 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.35;
}

.codex-plugins__banner--error {
  color: #fecaca;
  background: rgba(127, 29, 29, 0.35);
  border: 1px solid rgba(248, 113, 113, 0.3);
}

.codex-plugins__banner--success {
  color: #bbf7d0;
  background: rgba(20, 83, 45, 0.32);
  border: 1px solid rgba(74, 222, 128, 0.25);
}

.codex-plugins__banner--warn {
  color: #fde68a;
  background: rgba(113, 63, 18, 0.32);
  border: 1px solid rgba(251, 191, 36, 0.25);
}

.codex-plugins__form {
  display: grid;
  gap: 8px;
  margin: 10px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.035);
}

.codex-plugins__input {
  width: 100%;
}

.codex-plugins__textarea {
  width: 100%;
  min-height: 64px;
  resize: vertical;
  padding: 8px;
  color: var(--text);
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
}

.codex-plugins__form-actions {
  display: flex;
  gap: 8px;
}

.codex-plugins__list {
  padding: 10px;
  overflow: auto;
}

.codex-plugins__group {
  margin-bottom: 14px;
}

.codex-plugins__group-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 7px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0;
}

.codex-plugins__empty {
  color: var(--muted);
  font-size: 12px;
  padding: 8px 0;
}

.codex-plugins__card {
  display: grid;
  gap: 8px;
  padding: 9px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.035);
}

.codex-plugins__card-main {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.codex-plugins__avatar {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: #f8fafc;
  background: #2563eb;
  font-size: 12px;
  font-weight: 700;
}

.codex-plugins__meta {
  min-width: 0;
  flex: 1;
}

.codex-plugins__name {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.codex-plugins__selector,
.codex-plugins__source,
.codex-plugins__desc {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}

.codex-plugins__badges {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 7px;
}

.codex-plugins__badges span {
  padding: 2px 5px;
  border-radius: 4px;
  color: #cbd5e1;
  background: rgba(148, 163, 184, 0.12);
  border: 1px solid rgba(148, 163, 184, 0.16);
  font-size: 10px;
}

.codex-plugins__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.codex-plugins__actions .tb-btn {
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
}

.codex-plugins__danger {
  color: #fecaca;
}
```

- [ ] **Step 4: Run frontend build**

Run from `frontend/`:

```powershell
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit Task 7**

```powershell
git add frontend/src/workbench/ActivityBar.tsx frontend/src/workbench/Workbench.tsx frontend/src/workbench/workbench.css
git commit -m "feat: wire codex plugin sidebar"
```

## Task 8: Final Verification

**Files:**
- Verify backend and frontend.

- [ ] **Step 1: Run backend tests**

Run from `backend/`:

```powershell
npm test -- src/codex-plugins.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run backend build**

Run from `backend/`:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run frontend build**

Run from `frontend/`:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Start the app for manual inspection**

Run from the repository root:

```powershell
.\dev.ps1
```

Expected: backend on `http://127.0.0.1:4178` and frontend on `http://127.0.0.1:5173`.

- [ ] **Step 5: Manual checks**

Open the frontend and check:

- The ActivityBar has a Codex Plugins icon.
- Selecting it opens the Codex Plugins sidebar.
- `superpowers@openai-api-curated` appears from config/cache discovery on this machine.
- Creating a local plugin adds it to the Local group.
- Install and uninstall buttons send API requests and refresh the snapshot.
- Delete source confirmation rejects unsafe paths and does not delete cache plugins.
- Sidebar text does not overlap at the default side width.

- [ ] **Step 6: Commit final verification notes if code changed during fixes**

If verification required code fixes, stage only the files changed by this feature:

```powershell
git add backend/package.json backend/src/errors.ts backend/src/codex-plugins.ts backend/src/codex-plugins.test.ts backend/src/routes/codex-plugins.ts backend/src/server.ts frontend/src/workbench/api.ts frontend/src/workbench/CodexPluginsView.tsx frontend/src/workbench/ActivityBar.tsx frontend/src/workbench/Workbench.tsx frontend/src/workbench/workbench.css
git commit -m "fix: verify codex plugin manager"
```

Expected: no commit is needed if Tasks 1 through 7 already pass verification unchanged.

## Self-Review

Spec coverage:

- Left sidebar entry: Task 7.
- Backend hybrid CLI and local file discovery: Tasks 2 and 3.
- API routes: Task 4.
- Frontend API client and view: Tasks 5 and 6.
- Safety rules for source deletion: Task 3.
- Error handling for missing CLI and bad CLI JSON: Tasks 1 and 2.
- Build and manual verification: Task 8.

Unresolved-marker scan:

- The plan contains concrete file paths, test code, implementation code, commands, and expected outcomes. It contains no unresolved blanks.

Type consistency:

- Backend uses `CodexPluginRecord`, `CodexPluginSnapshot`, `CodexMarketplaceRecord`, `CodexPluginServiceOptions`, and the same endpoint names consumed by frontend API helpers.
- Frontend API helper names match the names imported by `CodexPluginsView.tsx`.
