import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { errors } from "../errors.js";
import { installRegistryTemplate, loadTemplateRegistry } from "../template-registry.js";
import {
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  getWorkflowTemplateIcon,
  listLocalWorkflowTemplates,
  listWorkflowTemplates,
  saveWorkflowAsTemplate,
  type TemplateSource,
  updateWorkflowTemplateIcon,
} from "../templates.js";
import { stopWorkflowRunAndWait } from "../workflow-runner.js";
import {
  createWorkflow,
  deleteWorkflow,
  findWorkflowByTemplateBinding,
  getWorkflow,
  listWorkflowIdsByTemplateBinding,
  saveWorkflow,
} from "../workflows.js";
import { listWorkspaces, resolveWorkspace } from "../workspace.js";

function sourceOf(value: string): TemplateSource {
  if (value === "system" || value === "user") return value;
  throw errors.invalidPath("template source is invalid");
}

function assertEditable(source: TemplateSource): void {
  if (source === "system" && !config.developerMode) {
    throw errors.invalidPath("system templates can only be edited in developer mode");
  }
}

export async function registerTemplateRoutes(app: FastifyInstance) {
  app.get("/api/templates/capabilities", async () => ({
    developerMode: config.developerMode,
  }));

  app.get("/api/templates", async () => await listWorkflowTemplates());
  app.get("/api/templates/local", async () => await listLocalWorkflowTemplates());

  // The marketspace is intentionally separate from user/system CRUD so clients can
  // refresh available templates without mutating the local library.
  app.get("/api/templates/marketspace", async () => await loadTemplateRegistry());

  app.post<{ Params: { id: string } }>("/api/templates/marketspace/:id/install", async (req) => {
    const registry = await loadTemplateRegistry();
    const entry = registry.templates.find((item) => item.id === req.params.id);
    if (!entry) throw errors.notFound(`template not found: ${req.params.id}`);
    await installRegistryTemplate(entry);
    return await getWorkflowTemplate("system", entry.id);
  });

  app.get<{ Params: { source: string; tid: string } }>(
    "/api/templates/:source/:tid/icon",
    async (req, reply) => {
      const icon = await getWorkflowTemplateIcon(sourceOf(req.params.source), req.params.tid);
      return reply.type(icon.mime).header("cache-control", "no-cache").send(icon.data);
    },
  );

  app.get<{ Params: { source: string; tid: string } }>(
    "/api/templates/:source/:tid",
    async (req) => await getWorkflowTemplate(sourceOf(req.params.source), req.params.tid),
  );

  app.post<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid/template",
    async (req) => {
      const workspace = await resolveWorkspace(req.params.id);
      const workflow = await getWorkflow(workspace.path, req.params.wid);
      return await saveWorkflowAsTemplate(workflow, "user");
    },
  );

  app.post<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid/system-template",
    async (req) => {
      assertEditable("system");
      const workspace = await resolveWorkspace(req.params.id);
      const workflow = await getWorkflow(workspace.path, req.params.wid);
      return await saveWorkflowAsTemplate(workflow, "system");
    },
  );

  app.post<{ Params: { id: string; source: string; tid: string } }>(
    "/api/workspaces/:id/templates/:source/:tid/edit",
    async (req) => {
      const source = sourceOf(req.params.source);
      assertEditable(source);
      const workspace = await resolveWorkspace(req.params.id);
      const template = await getWorkflowTemplate(source, req.params.tid);
      const existing = await findWorkflowByTemplateBinding(workspace.path, source, req.params.tid);
      if (existing) {
        return await saveWorkflow(workspace.path, {
          ...existing,
          title: template.title,
          readme: template.readme,
          nodes: template.nodes,
          edges: template.edges,
          runs: [],
        });
      }
      return await createWorkflow(workspace.path, {
        title: template.title,
        readme: template.readme,
        templateBinding: { source, id: template.id },
        nodes: template.nodes,
        edges: template.edges,
        runs: [],
      });
    },
  );

  app.put<{
    Params: { source: string; tid: string };
    Body: { icon?: string };
  }>("/api/templates/:source/:tid/icon", async (req) => {
    const source = sourceOf(req.params.source);
    assertEditable(source);
    return await updateWorkflowTemplateIcon(source, req.params.tid, req.body?.icon ?? "");
  });

  app.delete<{ Params: { source: string; tid: string } }>(
    "/api/templates/:source/:tid",
    async (req) => {
      const source = sourceOf(req.params.source);
      assertEditable(source);
      const workspaces = await listWorkspaces();
      for (const workspace of workspaces) {
        const workflowIds = await listWorkflowIdsByTemplateBinding(
          workspace.path,
          source,
          req.params.tid,
        );
        for (const workflowId of workflowIds) {
          await stopWorkflowRunAndWait(workspace.id, workflowId);
          await deleteWorkflow(workspace.path, workflowId);
        }
      }
      await deleteWorkflowTemplate(source, req.params.tid);
      return { ok: true };
    },
  );
}
