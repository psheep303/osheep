import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import { errors } from "./errors.js";
import {
  installRegistryTemplate,
  loadTemplateRegistry,
} from "./template-registry.js";
import type { WorkflowEdge, WorkflowNode, WorkflowRecord } from "./workflows.js";

const TEMPLATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TEMPLATE_FILE = "template.json";
const MAX_ICON_BYTES = 2 * 1024 * 1024;

export type TemplateSource = "system" | "user";

export interface WorkflowTemplate {
  id: string;
  source: TemplateSource;
  title: string;
  description: string;
  version?: string;
  readme: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

interface StoredWorkflowTemplate extends Omit<WorkflowTemplate, "icon"> {
  iconFile?: string;
}

export interface WorkflowTemplateSummary {
  id: string;
  source: TemplateSource;
  title: string;
  description: string;
  version?: string;
  icon?: string;
  updatedAt: number;
  nodeCount: number;
}

export interface TemplateStoreOptions {
  root?: string;
  systemSourceRoot?: string;
  developerMode?: boolean;
}

function options(value: TemplateStoreOptions = {}): Required<TemplateStoreOptions> {
  return {
    root: value.root ?? config.templatesRoot,
    systemSourceRoot: value.systemSourceRoot ?? config.systemTemplatesRoot,
    developerMode: value.developerMode ?? config.developerMode,
  };
}

function usesDefaultMarketspace(opts: Required<TemplateStoreOptions>): boolean {
  return path.resolve(opts.root) === path.resolve(config.templatesRoot) &&
    path.resolve(opts.systemSourceRoot) === path.resolve(config.systemTemplatesRoot);
}

function randomPart(length: number): string {
  let out = "";
  while (out.length < length) out += Math.random().toString(36).slice(2);
  return out.slice(0, length);
}

function validateTemplateId(id: string): void {
  if (!TEMPLATE_ID_RE.test(id)) throw errors.invalidPath("template id is invalid");
}

function sourceDir(root: string, source: TemplateSource): string {
  return path.join(root, source);
}

function templateDir(root: string, source: TemplateSource, id: string): string {
  return path.join(sourceDir(root, source), id);
}

function templateFile(root: string, source: TemplateSource, id: string): string {
  return path.join(templateDir(root, source, id), TEMPLATE_FILE);
}

function systemSourceDir(systemSourceRoot: string, id: string): string {
  return path.join(systemSourceRoot, id);
}

function cleanNode(node: WorkflowNode): WorkflowNode {
  const { runDetails: _runDetails, ...nodeConfig } = node.config ?? {};
  return {
    ...node,
    status: "idle",
    summary: "",
    rawOutput: "",
    error: "",
    startedAt: undefined,
    completedAt: undefined,
    config: nodeConfig,
  };
}

function sanitizeStoredTemplate(
  raw: unknown,
  fallbackId: string,
  source: TemplateSource,
): StoredWorkflowTemplate {
  if (!raw || typeof raw !== "object") throw errors.invalidPath("template is invalid");
  const value = raw as Partial<StoredWorkflowTemplate> & { icon?: unknown };
  const id = typeof value.id === "string" && TEMPLATE_ID_RE.test(value.id) ? value.id : fallbackId;
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  const iconFile =
    typeof value.iconFile === "string" && path.basename(value.iconFile) === value.iconFile
      ? value.iconFile
      : undefined;
  return {
    id,
    source,
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title.trim()
        : "Workflow template",
    description:
      typeof value.description === "string"
        ? value.description
        : source === "system"
          ? "Built-in workflow template"
          : "Custom workflow template",
    version: typeof value.version === "string" ? value.version : undefined,
    readme: typeof value.readme === "string" ? value.readme : "",
    iconFile,
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
    nodes: Array.isArray(value.nodes) ? value.nodes.map(cleanNode) : [],
    edges: Array.isArray(value.edges) ? value.edges.map((edge) => ({ ...edge })) : [],
  };
}

function publicTemplate(template: StoredWorkflowTemplate): WorkflowTemplate {
  return {
    id: template.id,
    source: template.source,
    title: template.title,
    description: template.description,
    version: template.version,
    readme: template.readme,
    icon: template.iconFile
      ? `/api/templates/${template.source}/${encodeURIComponent(template.id)}/icon?v=${template.updatedAt}`
      : undefined,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    nodes: template.nodes,
    edges: template.edges,
  };
}

function summary(template: StoredWorkflowTemplate): WorkflowTemplateSummary {
  const view = publicTemplate(template);
  return {
    id: view.id,
    source: view.source,
    title: view.title,
    description: view.description,
    version: view.version,
    icon: view.icon,
    updatedAt: view.updatedAt,
    nodeCount: view.nodes.length,
  };
}

async function migrateLegacyUserTemplates(root: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    if (!TEMPLATE_ID_RE.test(id)) continue;
    const legacyFile = path.join(root, entry);
    try {
      const raw = JSON.parse(await fs.readFile(legacyFile, "utf8")) as Record<string, unknown>;
      const stored = sanitizeStoredTemplate(raw, id, "user");
      await writeStoredTemplate(stored, root);
      if (typeof raw.icon === "string" && raw.icon.startsWith("data:image/")) {
        await writeTemplateIcon(stored, raw.icon, root);
      }
      await fs.unlink(legacyFile);
    } catch {
      // Leave invalid legacy files untouched so a developer can recover them.
    }
  }
}

const templateLibraryQueues = new Map<string, Promise<void>>();

async function sourceSignature(systemSourceRoot: string): Promise<string | null> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  try {
    await visit(systemSourceRoot);
    if (!files.length) return null;

    const hash = createHash("sha1");
    for (const file of files) {
      const relative = path.relative(systemSourceRoot, file).split(path.sep).join("/");
      const data = await fs.readFile(file);
      hash.update(`${Buffer.byteLength(relative)}:${relative}${data.length}:`);
      hash.update(data);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

async function canonicalSyncPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return path.join(await fs.realpath(current), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missingSegments);
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function templateLibraryDestinationKey(root: string): Promise<string> {
  const destination = await canonicalSyncPath(sourceDir(root, "system"));
  return process.platform === "win32" ? destination.toLowerCase() : destination;
}

async function withTemplateLibrary<T>(
  opts: Required<TemplateStoreOptions>,
  callback: () => Promise<T>,
): Promise<T> {
  const destinationKey = await templateLibraryDestinationKey(opts.root);
  const previousTail = templateLibraryQueues.get(destinationKey) ?? Promise.resolve();
  const operation = previousTail.then(async () => {
    await fs.mkdir(sourceDir(opts.root, "system"), { recursive: true });
    await fs.mkdir(sourceDir(opts.root, "user"), { recursive: true });
    await migrateLegacyUserTemplates(opts.root);
    await syncBundledSystemTemplatesOnce(opts.root, opts.systemSourceRoot);
    return callback();
  });
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  templateLibraryQueues.set(destinationKey, tail);

  try {
    return await operation;
  } finally {
    if (templateLibraryQueues.get(destinationKey) === tail) {
      templateLibraryQueues.delete(destinationKey);
    }
  }
}

async function syncBundledSystemTemplatesOnce(
  root: string,
  systemSourceRoot: string,
): Promise<void> {
  const signature = await sourceSignature(systemSourceRoot);
  if (!signature) {
    // The bundled system library was replaced by the remote marketspace. Remove
    // stale runtime copies when an upgrade leaves the source directory empty.
    if (path.resolve(systemSourceRoot) === path.resolve(config.systemTemplatesRoot)) {
      await fs.rm(sourceDir(root, "system"), { recursive: true, force: true });
      await fs.mkdir(sourceDir(root, "system"), { recursive: true });
      await fs.rm(path.join(root, ".system-sync.json"), { force: true });
    }
    return;
  }

  const markerFile = path.join(root, ".system-sync.json");
  try {
    const marker = JSON.parse(await fs.readFile(markerFile, "utf8")) as { signature?: string };
    if (marker.signature === signature) return;
  } catch {
    // Missing or invalid markers are repaired by a full sync below.
  }

  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(systemSourceRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const templateDirs = entries.filter(
    (entry) => entry.isDirectory() && TEMPLATE_ID_RE.test(entry.name),
  );
  if (!templateDirs.length) return;
  const runtimeRoot = sourceDir(root, "system");
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  for (const entry of templateDirs) {
    await fs.cp(path.join(systemSourceRoot, entry.name), path.join(runtimeRoot, entry.name), {
      recursive: true,
    });
  }
  await fs.writeFile(markerFile, JSON.stringify({ signature }), "utf8");
}

async function readStoredTemplate(
  source: TemplateSource,
  id: string,
  opts: Required<TemplateStoreOptions>,
): Promise<StoredWorkflowTemplate> {
  validateTemplateId(id);
  try {
    const text = await fs.readFile(templateFile(opts.root, source, id), "utf8");
    return sanitizeStoredTemplate(JSON.parse(text), id, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw errors.notFound(`template not found: ${id}`);
    }
    if (error instanceof SyntaxError) throw errors.ioError("template file parse failed");
    throw error;
  }
}

async function writeStoredTemplate(template: StoredWorkflowTemplate, root: string): Promise<void> {
  const dir = templateDir(root, template.source, template.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, TEMPLATE_FILE), JSON.stringify(template, null, 2), "utf8");
}

async function writeSystemSourceTemplate(
  template: StoredWorkflowTemplate,
  systemSourceRoot: string,
): Promise<void> {
  const dir = systemSourceDir(systemSourceRoot, template.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, TEMPLATE_FILE), JSON.stringify(template, null, 2), "utf8");
}

function requireDeveloperMode(opts: Required<TemplateStoreOptions>): void {
  if (!opts.developerMode) {
    throw errors.invalidPath("system templates can only be changed in developer mode");
  }
}

function storedFromWorkflow(
  workflow: WorkflowRecord,
  source: TemplateSource,
  previous?: StoredWorkflowTemplate,
): StoredWorkflowTemplate {
  const now = Date.now();
  return {
    id: previous?.id ?? `tpl_${randomPart(12)}`,
    source,
    title: workflow.title || "Workflow template",
    description:
      previous?.description ??
      (source === "system" ? "Built-in workflow template" : "Custom workflow template"),
    readme: workflow.readme ?? "",
    iconFile: previous?.iconFile,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    nodes: workflow.nodes.map(cleanNode),
    edges: workflow.edges.map((edge) => ({ ...edge })),
  };
}

async function listWorkflowTemplatesInternal(
  value: TemplateStoreOptions = {},
  includeMarketspace = true,
): Promise<{
  system: WorkflowTemplateSummary[];
  user: WorkflowTemplateSummary[];
  developerMode: boolean;
}> {
  const opts = options(value);
  return withTemplateLibrary(opts, async () => {
    const readSource = async (source: TemplateSource) => {
      const result: WorkflowTemplateSummary[] = [];
      await fs.mkdir(sourceDir(opts.root, source), { recursive: true });
      const entries = await fs.readdir(sourceDir(opts.root, source), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !TEMPLATE_ID_RE.test(entry.name)) continue;
        try {
          result.push(summary(await readStoredTemplate(source, entry.name, opts)));
        } catch {
          // Ignore one invalid template without hiding the rest of the library.
        }
      }
      result.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
      return result;
    };
    const [localSystem, user] = await Promise.all([readSource("system"), readSource("user")]);
    let system = localSystem;
    if (includeMarketspace && usesDefaultMarketspace(opts)) {
      try {
        const registry = await loadTemplateRegistry();
        const installed = new Map(system.map((item) => [item.id, item]));
        const marketspace = registry.templates.map((entry) => {
          const cached = installed.get(entry.id);
          return cached
            ? {
                ...cached,
                title: entry.name,
                description: entry.description,
                version: entry.version,
              }
            : {
                id: entry.id,
                source: "system" as const,
                title: entry.name,
                description: entry.description,
                version: entry.version,
                updatedAt: 0,
                nodeCount: 0,
            };
        });
        const registryIds = new Set(registry.templates.map((entry) => entry.id));
        system = [...marketspace, ...system.filter((item) => !registryIds.has(item.id))];
      } catch {
        // A cached local marketspace remains usable when the registry is offline.
      }
    }
    return {
      system,
      user,
      developerMode: opts.developerMode,
    };
  });
}

export async function listWorkflowTemplates(value: TemplateStoreOptions = {}) {
  return listWorkflowTemplatesInternal(value, true);
}

export async function listLocalWorkflowTemplates(value: TemplateStoreOptions = {}) {
  return listWorkflowTemplatesInternal(value, false);
}

export async function getWorkflowTemplate(
  source: TemplateSource,
  id: string,
  value: TemplateStoreOptions = {},
): Promise<WorkflowTemplate> {
  const opts = options(value);
  return withTemplateLibrary(opts, async () => {
    try {
      const stored = await readStoredTemplate(source, id, opts);
      if (source === "system" && usesDefaultMarketspace(opts)) {
        try {
          const entry = (await loadTemplateRegistry()).templates.find((item) => item.id === id);
          if (entry && stored.version !== entry.version) {
            await installRegistryTemplate(entry);
            await syncBundledSystemTemplatesOnce(opts.root, opts.systemSourceRoot);
            return publicTemplate(await readStoredTemplate(source, id, opts));
          }
        } catch {
          // A cached installed template remains usable while the registry is offline.
        }
      }
      return publicTemplate(stored);
    } catch (error) {
      const missing =
        error && typeof error === "object" &&
        (error as { statusCode?: number }).statusCode === 404;
      if (!missing || source !== "system" || !usesDefaultMarketspace(opts)) throw error;
      const registry = await loadTemplateRegistry();
      const entry = registry.templates.find((item) => item.id === id);
      if (!entry) throw error;
      await installRegistryTemplate(entry);
      await syncBundledSystemTemplatesOnce(opts.root, opts.systemSourceRoot);
      return publicTemplate(await readStoredTemplate(source, id, opts));
    }
  });
}

export async function saveWorkflowAsTemplate(
  workflow: WorkflowRecord,
  source: TemplateSource = "user",
  value: TemplateStoreOptions = {},
): Promise<WorkflowTemplate> {
  const opts = options(value);
  if (source === "system") requireDeveloperMode(opts);
  return withTemplateLibrary(opts, async () => {
    const template = storedFromWorkflow(workflow, source);
    await writeStoredTemplate(template, opts.root);
    if (source === "system") {
      await writeSystemSourceTemplate(template, opts.systemSourceRoot);
    }
    return publicTemplate(template);
  });
}

export async function updateTemplateFromWorkflow(
  workflow: WorkflowRecord,
  value: TemplateStoreOptions = {},
): Promise<WorkflowTemplate | null> {
  const opts = options(value);
  return withTemplateLibrary(opts, async () => {
    const binding = workflow.templateBinding;
    if (!binding) return null;
    if (binding.source === "system") requireDeveloperMode(opts);
    const previous = await readStoredTemplate(binding.source, binding.id, opts);
    const template = storedFromWorkflow(workflow, binding.source, previous);
    await writeStoredTemplate(template, opts.root);
    if (binding.source === "system") {
      await writeSystemSourceTemplate(template, opts.systemSourceRoot);
    }
    return publicTemplate(template);
  });
}

export async function updateWorkflowTemplateIcon(
  source: TemplateSource,
  id: string,
  icon: string,
  value: TemplateStoreOptions = {},
): Promise<WorkflowTemplate> {
  const opts = options(value);
  if (source === "system") requireDeveloperMode(opts);
  return withTemplateLibrary(opts, async () => {
    const template = await readStoredTemplate(source, id, opts);
    const updated = await writeTemplateIcon(template, icon, opts.root);
    if (source === "system") {
      await writeSystemSourceTemplate(updated, opts.systemSourceRoot);
      await copyIconToSystemSource(updated, opts.root, opts.systemSourceRoot);
    }
    return publicTemplate(updated);
  });
}

async function writeTemplateIcon(
  template: StoredWorkflowTemplate,
  dataUrl: string,
  root: string,
): Promise<StoredWorkflowTemplate> {
  const match = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,([a-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) throw errors.invalidPath("template icon must be an image data URL");
  const data = Buffer.from(match[2]!, "base64");
  if (data.length > MAX_ICON_BYTES) throw errors.invalidPath("template icon is too large");
  const extension =
    match[1]!.toLowerCase() === "jpeg"
      ? "jpg"
      : match[1]!.toLowerCase() === "svg+xml"
        ? "svg"
        : match[1]!.toLowerCase();
  const iconFile = `icon.${extension}`;
  const dir = templateDir(root, template.source, template.id);
  await fs.mkdir(dir, { recursive: true });
  if (template.iconFile && template.iconFile !== iconFile) {
    await fs.unlink(path.join(dir, template.iconFile)).catch(() => undefined);
  }
  await fs.writeFile(path.join(dir, iconFile), data);
  const updated = { ...template, iconFile, updatedAt: Date.now() };
  await writeStoredTemplate(updated, root);
  return updated;
}

async function copyIconToSystemSource(
  template: StoredWorkflowTemplate,
  root: string,
  systemSourceRoot: string,
): Promise<void> {
  if (!template.iconFile) return;
  const targetDir = systemSourceDir(systemSourceRoot, template.id);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(
    path.join(templateDir(root, "system", template.id), template.iconFile),
    path.join(targetDir, template.iconFile),
  );
}

export async function getWorkflowTemplateIcon(
  source: TemplateSource,
  id: string,
  value: TemplateStoreOptions = {},
): Promise<{ data: Buffer; mime: string }> {
  const opts = options(value);
  return withTemplateLibrary(opts, async () => {
    const template = await readStoredTemplate(source, id, opts);
    if (!template.iconFile) throw errors.notFound("template icon not found");
    const extension = path.extname(template.iconFile).toLowerCase();
    const mime =
      extension === ".png"
        ? "image/png"
        : extension === ".jpg" || extension === ".jpeg"
          ? "image/jpeg"
          : extension === ".webp"
            ? "image/webp"
            : extension === ".gif"
              ? "image/gif"
              : extension === ".svg"
                ? "image/svg+xml"
                : "application/octet-stream";
    return {
      data: await fs.readFile(path.join(templateDir(opts.root, source, id), template.iconFile)),
      mime,
    };
  });
}

export async function deleteWorkflowTemplate(
  source: TemplateSource,
  id: string,
  value: TemplateStoreOptions = {},
): Promise<void> {
  const opts = options(value);
  if (source === "system") requireDeveloperMode(opts);
  await withTemplateLibrary(opts, async () => {
    await readStoredTemplate(source, id, opts);
    await fs.rm(templateDir(opts.root, source, id), { recursive: true, force: true });
    if (source === "system") {
      await fs.rm(systemSourceDir(opts.systemSourceRoot, id), {
        recursive: true,
        force: true,
      });
    }
  });
}
