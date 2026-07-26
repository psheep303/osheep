import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";
import { type SearchOptions, searchWorkspace } from "../search.js";
import { resolveWorkspace } from "../workspace.js";

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

function parseList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBoundedInt(v: string | undefined, fallback: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export async function registerSearchRoutes(app: FastifyInstance) {
  app.get<{
    Params: { id: string };
    Querystring: {
      query?: string;
      caseSensitive?: string;
      wholeWord?: string;
      regex?: string;
      include?: string;
      exclude?: string;
      maxFiles?: string;
      maxMatchesPerFile?: string;
    };
  }>("/api/workspaces/:id/search", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const q = req.query.query ?? "";
    if (!q) throw errors.invalidQuery("query 不能为空");

    const opts: SearchOptions = {
      query: q,
      caseSensitive: parseBool(req.query.caseSensitive, false),
      wholeWord: parseBool(req.query.wholeWord, false),
      regex: parseBool(req.query.regex, false),
      include: parseList(req.query.include),
      exclude: parseList(req.query.exclude),
      maxFiles: parseBoundedInt(req.query.maxFiles, 5000, 50000),
      maxMatchesPerFile: parseBoundedInt(req.query.maxMatchesPerFile, 100, 1000),
    };

    return await searchWorkspace(ws.path, opts);
  });
}
