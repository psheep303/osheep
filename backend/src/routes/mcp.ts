import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";
import { callRemoteMcp, discoverRemoteMcp } from "../remote-mcp.js";
import { resolveWorkspace } from "../workspace.js";

interface McpConnectionBody {
  remoteLink?: unknown;
  postUrl?: unknown;
  headers?: unknown;
  apiKey?: unknown;
}

interface McpCallBody extends McpConnectionBody {
  name?: unknown;
  arguments?: unknown;
}

export async function registerMcpRoutes(app: FastifyInstance) {
  app.post<{
    Params: { id: string };
    Body: McpConnectionBody;
  }>("/api/workspaces/:id/mcp/discover", async (req) => {
    await resolveWorkspace(req.params.id);
    const connection = parseConnectionBody(req.body);
    return await discoverRemoteMcp(connection);
  });

  app.post<{
    Params: { id: string };
    Body: McpCallBody;
  }>("/api/workspaces/:id/mcp/call", async (req) => {
    await resolveWorkspace(req.params.id);
    const connection = parseConnectionBody(req.body);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) throw errors.invalidQuery("MCP tool name is required");
    const args = objectOrEmpty(req.body?.arguments, "MCP arguments must be a JSON object");
    const result = await callRemoteMcp({
      ...connection,
      name,
      arguments: args,
    });
    if (!result.ok) {
      return {
        ...result,
        status: "failed",
      };
    }
    return {
      ...result,
      status: "success",
    };
  });
}

function parseConnectionBody(body: McpConnectionBody | undefined): {
  remoteLink: string;
  postUrl?: string;
  headers: Record<string, string>;
  apiKey?: string;
} {
  const remoteLink = typeof body?.remoteLink === "string" ? body.remoteLink.trim() : "";
  if (!remoteLink) throw errors.invalidQuery("Remote MCP Link is required");
  const postUrl = typeof body?.postUrl === "string" ? body.postUrl.trim() : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  return {
    remoteLink,
    postUrl: postUrl || undefined,
    headers: parseHeaders(body?.headers),
    apiKey: apiKey || undefined,
  };
}

function parseHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw errors.invalidQuery("Headers must be valid JSON");
    }
    return parseHeaders(parsed);
  }
  const obj = objectValue(value);
  if (!obj) throw errors.invalidQuery("Headers must be a JSON object");
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (!key.trim()) continue;
    if (typeof raw !== "string") {
      throw errors.invalidQuery(`Header ${key} must be a string`);
    }
    out[key.trim()] = raw;
  }
  return out;
}

function objectOrEmpty(value: unknown, errorMessage: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const obj = objectValue(value);
  if (!obj) throw errors.invalidQuery(errorMessage);
  return obj;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
