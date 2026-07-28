import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".map", ".svg"]);

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function etagFor(fileStats: Stats): string {
  return `W/"${fileStats.size.toString(16)}-${Math.round(fileStats.mtimeMs).toString(16)}"`;
}

async function statIfFile(filePath: string): Promise<Stats | null> {
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile() ? fileStats : null;
  } catch {
    return null;
  }
}

function acceptsGzip(header: string | string[] | undefined): boolean {
  return String(header ?? "")
    .split(",")
    .some((entry) => {
      const [coding, ...parameters] = entry.trim().toLowerCase().split(";");
      if (coding !== "gzip") return false;

      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      return quality === undefined || Number(quality.slice(2)) > 0;
    });
}

async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  fileStats: Stats,
  immutable: boolean,
) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (contentType) reply.type(contentType);

  const gzipPath = `${filePath}.gz`;
  const gzipStats = COMPRESSIBLE.has(extension) ? await statIfFile(gzipPath) : null;
  if (gzipStats) reply.header("vary", "accept-encoding");

  if (immutable) {
    reply.header("cache-control", "public, max-age=31536000, immutable");
  } else {
    const etag = etagFor(fileStats);
    reply.header("cache-control", "no-cache");
    reply.header("etag", etag);
    if (request.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }
  }

  if (gzipStats && acceptsGzip(request.headers["accept-encoding"])) {
    reply.header("content-encoding", "gzip");
    return reply.send(createReadStream(gzipPath));
  }

  return reply.send(createReadStream(filePath));
}

export async function registerStaticSite(app: FastifyInstance, rawRoot: string) {
  const root = path.resolve(rawRoot);
  const indexPath = path.join(root, "index.html");
  if (!(await statIfFile(indexPath))) {
    throw new Error(`OSHEEP_FRONTEND_ROOT does not contain index.html: ${root}`);
  }

  app.get("/*", async (request, reply) => {
    const rawPath = request.url.split("?", 1)[0] ?? "/";
    if (rawPath === "/api" || rawPath.startsWith("/api/")) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "API route not found" },
      });
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return reply.status(400).send("Invalid URL path");
    }

    const candidate = path.resolve(root, `.${decodedPath}`);
    if (!isInside(root, candidate)) return reply.status(404).send("Not found");

    const candidateStats = await statIfFile(candidate);
    if (candidateStats) {
      return sendFile(
        request,
        reply,
        candidate,
        candidateStats,
        decodedPath.startsWith("/assets/"),
      );
    }

    // Extensionless paths are client-side routes; asset misses remain real 404s.
    if (!path.extname(decodedPath)) {
      const indexStats = await statIfFile(indexPath);
      if (indexStats) return sendFile(request, reply, indexPath, indexStats, false);
    }
    return reply.status(404).send("Not found");
  });
}
