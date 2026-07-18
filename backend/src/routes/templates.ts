import type { FastifyInstance } from "fastify";
import { resolveWorkspace } from "../workspace.js";
import { getWorkflow } from "../workflows.js";
import {
  getWorkflowTemplate,
  deleteWorkflowTemplate,
  listWorkflowTemplates,
  saveWorkflowAsTemplate,
  updateWorkflowTemplateIcon,
  type TemplateSource,
} from "../templates.js";

function sourceOf(value: string): TemplateSource {
  return value === "system" ? "system" : "user";
}

export async function registerTemplateRoutes(app: FastifyInstance) {
  app.get("/api/templates", async () => await listWorkflowTemplates());

  app.get<{ Params: { source: string; tid: string } }>(
    "/api/templates/:source/:tid",
    async (req) => await getWorkflowTemplate(sourceOf(req.params.source), req.params.tid)
  );

  app.post<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid/template",
    async (req) => {
      const workspace = await resolveWorkspace(req.params.id);
      const workflow = await getWorkflow(workspace.path, req.params.wid);
      return await saveWorkflowAsTemplate(workflow);
    }
  );

  app.put<{
    Params: { tid: string };
    Body: { icon?: string };
  }>("/api/templates/user/:tid/icon", async (req) => {
    return await updateWorkflowTemplateIcon(req.params.tid, req.body?.icon ?? "");
  });

  app.delete<{ Params: { tid: string } }>(
    "/api/templates/user/:tid",
    async (req) => {
      await deleteWorkflowTemplate(req.params.tid);
      return { ok: true };
    }
  );
}
