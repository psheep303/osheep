import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import { errors } from "./errors.js";
import type { WorkflowEdge, WorkflowNode, WorkflowRecord } from "./workflows.js";

const TEMPLATE_ID_RE = /^tpl_[a-z0-9]{8,32}$/;
const TEMPLATE_FILE = "template.json";
const MAX_ICON_BYTES = 2 * 1024 * 1024;

export type TemplateSource = "system" | "user";

export interface WorkflowTemplate {
  id: string;
  source: TemplateSource;
  title: string;
  description: string;
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
    icon: view.icon,
    updatedAt: view.updatedAt,
    nodeCount: view.nodes.length,
  };
}

async function ensureLibrary(opts: Required<TemplateStoreOptions>): Promise<void> {
  await fs.mkdir(sourceDir(opts.root, "system"), { recursive: true });
  await fs.mkdir(sourceDir(opts.root, "user"), { recursive: true });
  await migrateLegacyUserTemplates(opts.root);
  await syncBundledSystemTemplates(opts.root, opts.systemSourceRoot);
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

const systemSyncs = new Map<string, Promise<void>>();

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

function systemSyncKey(root: string, systemSourceRoot: string): string {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return `${normalize(root)}\0${normalize(systemSourceRoot)}`;
}

async function syncBundledSystemTemplates(root: string, systemSourceRoot: string): Promise<void> {
  const key = systemSyncKey(root, systemSourceRoot);
  const active = systemSyncs.get(key);
  if (active) return active;

  const sync = syncBundledSystemTemplatesOnce(root, systemSourceRoot);
  systemSyncs.set(key, sync);
  try {
    await sync;
  } finally {
    if (systemSyncs.get(key) === sync) systemSyncs.delete(key);
  }
}

async function syncBundledSystemTemplatesOnce(
  root: string,
  systemSourceRoot: string,
): Promise<void> {
  const signature = await sourceSignature(systemSourceRoot);
  if (!signature) return;

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
  ensure = true,
): Promise<StoredWorkflowTemplate> {
  validateTemplateId(id);
  if (ensure) await ensureLibrary(opts);
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

export async function listWorkflowTemplates(value: TemplateStoreOptions = {}): Promise<{
  system: WorkflowTemplateSummary[];
  user: WorkflowTemplateSummary[];
  developerMode: boolean;
}> {
  const opts = options(value);
  await ensureLibrary(opts);
  const readSource = async (source: TemplateSource) => {
    const result: WorkflowTemplateSummary[] = [];
    const entries = await fs.readdir(sourceDir(opts.root, source), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !TEMPLATE_ID_RE.test(entry.name)) continue;
      try {
        result.push(summary(await readStoredTemplate(source, entry.name, opts, false)));
      } catch {
        // Ignore one invalid template without hiding the rest of the library.
      }
    }
    result.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
    return result;
  };
  return {
    system: await readSource("system"),
    user: await readSource("user"),
    developerMode: opts.developerMode,
  };
}

export async function getWorkflowTemplate(
  source: TemplateSource,
  id: string,
  value: TemplateStoreOptions = {},
): Promise<WorkflowTemplate> {
  const opts = options(value);
  return publicTemplate(await readStoredTemplate(source, id, opts));
}

export async function saveWorkflowAsTemplate(
  workflow: WorkflowRecord,
  source: TemplateSource = "user",
  value: TemplateStoreOptions = {},
): Promise<WorkflowTemplate> {
  const opts = options(value);
  if (source === "system") requireDeveloperMode(opts);
  await ensureLibrary(opts);
  const template = storedFromWorkflow(workflow, source);
  await writeStoredTemplate(template, opts.root);
  if (source === "system") {
    await writeSystemSourceTemplate(template, opts.systemSourceRoot);
  }
  return publicTemplate(template);
}

export async function updateTemplateFromWorkflow(
  workflow: WorkflowRecord,
  value: TemplateStoreOptions = {},
): Promise<WorkflowTemplate | null> {
  const binding = workflow.templateBinding;
  if (!binding) return null;
  const opts = options(value);
  if (binding.source === "system") requireDeveloperMode(opts);
  const previous = await readStoredTemplate(binding.source, binding.id, opts);
  const template = storedFromWorkflow(workflow, binding.source, previous);
  await writeStoredTemplate(template, opts.root);
  if (binding.source === "system") {
    await writeSystemSourceTemplate(template, opts.systemSourceRoot);
  }
  return publicTemplate(template);
}

export async function updateWorkflowTemplateIcon(
  source: TemplateSource,
  id: string,
  icon: string,
  value: TemplateStoreOptions = {},
): Promise<WorkflowTemplate> {
  const opts = options(value);
  if (source === "system") requireDeveloperMode(opts);
  const template = await readStoredTemplate(source, id, opts);
  const updated = await writeTemplateIcon(template, icon, opts.root);
  if (source === "system") {
    await writeSystemSourceTemplate(updated, opts.systemSourceRoot);
    await copyIconToSystemSource(updated, opts.root, opts.systemSourceRoot);
  }
  return publicTemplate(updated);
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
}

export async function deleteWorkflowTemplate(
  source: TemplateSource,
  id: string,
  value: TemplateStoreOptions = {},
): Promise<void> {
  const opts = options(value);
  if (source === "system") requireDeveloperMode(opts);
  await readStoredTemplate(source, id, opts);
  await fs.rm(templateDir(opts.root, source, id), { recursive: true, force: true });
  if (source === "system") {
    await fs.rm(systemSourceDir(opts.systemSourceRoot, id), {
      recursive: true,
      force: true,
    });
  }
}
