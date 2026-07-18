import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

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

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function sendFile(reply: FastifyReply, filePath: string) {
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  if (contentType) reply.type(contentType);
  return reply.send(createReadStream(filePath));
}

export async function registerStaticSite(app: FastifyInstance, rawRoot: string) {
  const root = path.resolve(rawRoot);
  const indexPath = path.join(root, "index.html");
  if (!(await isFile(indexPath))) {
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
    if (await isFile(candidate)) return sendFile(reply, candidate);

    // Extensionless paths are client-side routes; asset misses remain real 404s.
    if (!path.extname(decodedPath)) return sendFile(reply, indexPath);
    return reply.status(404).send("Not found");
  });
}
