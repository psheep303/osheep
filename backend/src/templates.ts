import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import { errors } from "./errors.js";
import type { WorkflowEdge, WorkflowNode, WorkflowRecord } from "./workflows.js";

const TEMPLATE_ID_RE = /^tpl_[a-z0-9]{8,32}$/;
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

export interface WorkflowTemplateSummary {
  id: string;
  source: TemplateSource;
  title: string;
  description: string;
  icon?: string;
  updatedAt: number;
  nodeCount: number;
}

const FALLBACK_SYSTEM_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "tpl_quickstart01",
    source: "system",
    title: "AI quick start",
    description: "A minimal trigger-to-agent workflow for everyday tasks.",
    readme: `# AI quick start

Use this template when you need a simple, reusable AI task.

## How it works

1. The workflow starts from a manual trigger.
2. The trigger passes its input to a Codex agent.
3. Edit the agent prompt to describe the task you want to automate.

Click **Use this template** to add a copy to the current workspace.`,
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "node_quicktrg",
        blockId: 1,
        kind: "trigger",
        title: "Workflow run",
        providerKind: "codex-cli",
        model: "default",
        prompt: "",
        x: 80,
        y: 120,
        status: "idle",
      },
      {
        id: "node_quickagt",
        blockId: 2,
        kind: "agent",
        title: "Codex",
        providerKind: "codex-cli",
        model: "default",
        prompt: "Describe the task this workflow should complete.",
        x: 360,
        y: 120,
        status: "idle",
      },
    ],
    edges: [
      {
        id: "edge_quick001",
        from: "node_quicktrg",
        to: "node_quickagt",
        passSummary: true,
      },
    ],
  },
  {
    id: "tpl_reviewflow1",
    source: "system",
    title: "Review and summarize",
    description: "Review an input, then turn the findings into a concise summary.",
    readme: `# Review and summarize

This two-stage workflow separates detailed review from final communication.

## Suggested uses

- Review a document or implementation plan
- Analyze a change and produce release notes
- Convert raw research into an executive summary

Customize both agent prompts after adding the template to your workspace.`,
    createdAt: 2,
    updatedAt: 2,
    nodes: [
      {
        id: "node_reviewtrg",
        blockId: 1,
        kind: "trigger",
        title: "Workflow run",
        providerKind: "codex-cli",
        model: "default",
        prompt: "",
        x: 60,
        y: 120,
        status: "idle",
      },
      {
        id: "node_reviewer1",
        blockId: 2,
        kind: "agent",
        title: "Reviewer",
        providerKind: "codex-cli",
        model: "default",
        prompt: "Review the input carefully. Identify risks, gaps, and important details.",
        x: 340,
        y: 120,
        status: "idle",
      },
      {
        id: "node_summary01",
        blockId: 3,
        kind: "agent",
        title: "Summarizer",
        providerKind: "codex-cli",
        model: "default",
        prompt: "Turn the review into a concise, actionable summary.",
        x: 620,
        y: 120,
        status: "idle",
      },
    ],
    edges: [
      {
        id: "edge_review01",
        from: "node_reviewtrg",
        to: "node_reviewer1",
        passSummary: true,
      },
      {
        id: "edge_review02",
        from: "node_reviewer1",
        to: "node_summary01",
        passSummary: true,
      },
    ],
  },
];

function randomPart(length: number): string {
  let out = "";
  while (out.length < length) out += Math.random().toString(36).slice(2);
  return out.slice(0, length);
}

function templateFile(root: string, id: string): string {
  return path.join(root, `${id}.json`);
}

function validateTemplateId(id: string): void {
  if (!TEMPLATE_ID_RE.test(id)) throw errors.invalidPath("template id is invalid");
}

async function ensureRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
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

function summary(template: WorkflowTemplate): WorkflowTemplateSummary {
  return {
    id: template.id,
    source: template.source,
    title: template.title,
    description: template.description,
    icon: template.icon,
    updatedAt: template.updatedAt,
    nodeCount: template.nodes.length,
  };
}

function sanitizeUserTemplate(raw: unknown, fallbackId: string): WorkflowTemplate {
  if (!raw || typeof raw !== "object") throw errors.invalidPath("template is invalid");
  const value = raw as Partial<WorkflowTemplate>;
  const id = typeof value.id === "string" && TEMPLATE_ID_RE.test(value.id)
    ? value.id
    : fallbackId;
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  return {
    id,
    source: "user",
    title: typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : "Workflow template",
    description: typeof value.description === "string"
      ? value.description
      : "Custom workflow template",
    readme: typeof value.readme === "string" ? value.readme : "",
    icon: typeof value.icon === "string" ? validateIcon(value.icon) : undefined,
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
    nodes: Array.isArray(value.nodes) ? value.nodes.map(cleanNode) : [],
    edges: Array.isArray(value.edges) ? value.edges.map((edge) => ({ ...edge })) : [],
  };
}

function sanitizeSystemTemplate(raw: unknown, fallbackId: string): WorkflowTemplate {
  const template = sanitizeUserTemplate(raw, fallbackId);
  return { ...template, source: "system" };
}

function validateIcon(value: string): string {
  if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/i.test(value)) {
    throw errors.invalidPath("template icon must be an image data URL");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ICON_BYTES) {
    throw errors.invalidPath("template icon is too large");
  }
  return value;
}

async function readUserTemplate(root: string, id: string): Promise<WorkflowTemplate> {
  validateTemplateId(id);
  try {
    const text = await fs.readFile(templateFile(root, id), "utf8");
    return sanitizeUserTemplate(JSON.parse(text), id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw errors.notFound(`template not found: ${id}`);
    }
    if (error instanceof SyntaxError) throw errors.ioError("template file parse failed");
    throw error;
  }
}

async function readSystemTemplates(root: string): Promise<WorkflowTemplate[]> {
  const templates: WorkflowTemplate[] = [];
  try {
    const entries = await fs.readdir(root);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -5);
      if (!TEMPLATE_ID_RE.test(id)) continue;
      try {
        const text = await fs.readFile(templateFile(root, id), "utf8");
        templates.push(sanitizeSystemTemplate(JSON.parse(text), id));
      } catch {
        // A broken developer template should not hide the remaining templates.
      }
    }
  } catch {
    // Packaged builds can fall back to the embedded starter templates.
  }
  templates.sort((a, b) => a.title.localeCompare(b.title));
  return templates.length
    ? templates
    : FALLBACK_SYSTEM_TEMPLATES.map((template) => structuredClone(template));
}

export async function listWorkflowTemplates(
  root = config.templatesRoot,
  systemRoot = config.systemTemplatesRoot
): Promise<{ system: WorkflowTemplateSummary[]; user: WorkflowTemplateSummary[] }> {
  await ensureRoot(root);
  const user: WorkflowTemplateSummary[] = [];
  const entries = await fs.readdir(root);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    if (!TEMPLATE_ID_RE.test(id)) continue;
    try {
      user.push(summary(await readUserTemplate(root, id)));
    } catch {
      // Ignore invalid user template files without hiding the rest of the library.
    }
  }
  user.sort((a, b) => b.updatedAt - a.updatedAt);
  const system = await readSystemTemplates(systemRoot);
  return { system: system.map(summary), user };
}

export async function getWorkflowTemplate(
  source: TemplateSource,
  id: string,
  root = config.templatesRoot,
  systemRoot = config.systemTemplatesRoot
): Promise<WorkflowTemplate> {
  validateTemplateId(id);
  if (source === "system") {
    const template = (await readSystemTemplates(systemRoot)).find((item) => item.id === id);
    if (!template) throw errors.notFound(`template not found: ${id}`);
    return structuredClone(template);
  }
  return await readUserTemplate(root, id);
}

export async function deleteWorkflowTemplate(
  id: string,
  root = config.templatesRoot
): Promise<void> {
  validateTemplateId(id);
  try {
    await fs.unlink(templateFile(root, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw errors.notFound(`template not found: ${id}`);
    }
    throw error;
  }
}

export async function saveWorkflowAsTemplate(
  workflow: WorkflowRecord,
  root = config.templatesRoot
): Promise<WorkflowTemplate> {
  await ensureRoot(root);
  const now = Date.now();
  const id = `tpl_${randomPart(12)}`;
  const template: WorkflowTemplate = {
    id,
    source: "user",
    title: workflow.title || "Workflow template",
    description: "Custom workflow template",
    readme: workflow.readme ?? "",
    createdAt: now,
    updatedAt: now,
    nodes: workflow.nodes.map(cleanNode),
    edges: workflow.edges.map((edge) => ({ ...edge })),
  };
  await fs.writeFile(templateFile(root, id), JSON.stringify(template, null, 2), "utf8");
  return template;
}

export async function updateWorkflowTemplateIcon(
  id: string,
  icon: string,
  root = config.templatesRoot
): Promise<WorkflowTemplate> {
  const current = await readUserTemplate(root, id);
  const next = { ...current, icon: validateIcon(icon), updatedAt: Date.now() };
  await fs.writeFile(templateFile(root, id), JSON.stringify(next, null, 2), "utf8");
  return next;
}
