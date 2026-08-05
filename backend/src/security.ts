import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { errors } from "./errors.js";

const SESSION_COOKIE = "osheep_session";

export interface SecurityOptions {
  host: string;
  corsOrigins: string[];
  authToken?: string;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function secretsEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || undefined;
}

export function createSecurity(options: SecurityOptions) {
  const remoteAccess = !isLoopbackHost(options.host);
  const explicitOrigins = new Set<string>();

  for (const value of options.corsOrigins) {
    if (value === "*") {
      throw new Error("CORS_ORIGIN cannot be '*'; configure explicit trusted origins");
    }
    const origin = normalizedOrigin(value);
    if (!origin) throw new Error(`Invalid CORS_ORIGIN value: ${value}`);
    explicitOrigins.add(origin);
  }

  if (remoteAccess && !options.authToken) {
    throw new Error("OSHEEP_AUTH_TOKEN is required when OSHEEP_HOST is not loopback");
  }
  if (remoteAccess && (options.authToken?.length ?? 0) < 32) {
    throw new Error("OSHEEP_AUTH_TOKEN must contain at least 32 characters for remote access");
  }
  if (remoteAccess && explicitOrigins.size === 0) {
    throw new Error("CORS_ORIGIN must list trusted origins when OSHEEP_HOST is not loopback");
  }

  const sessionToken = options.authToken ?? randomBytes(32).toString("base64url");

  const isTrustedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return false;
    const normalized = normalizedOrigin(origin);
    if (!normalized) return false;
    if (!remoteAccess && isLoopbackOrigin(normalized)) return true;
    return explicitOrigins.has(normalized);
  };

  const hasTrustedRequestOrigin = (request: FastifyRequest): boolean => {
    const origin = request.headers.origin;
    if (origin) return isTrustedOrigin(origin);
    return request.headers["sec-fetch-site"] !== "cross-site";
  };

  const hasSession = (request: FastifyRequest): boolean =>
    secretsEqual(cookieValue(request.headers.cookie, SESSION_COOKIE), sessionToken);

  const hasBearer = (request: FastifyRequest): boolean =>
    secretsEqual(bearerToken(request.headers.authorization), sessionToken);

  const register = async (app: FastifyInstance): Promise<void> => {
    app.addHook("onRequest", async (request) => {
      if (!request.url.startsWith("/api/")) return;
      if (!hasTrustedRequestOrigin(request)) throw errors.originNotAllowed();
      if (
        request.method === "OPTIONS" ||
        request.url === "/api/health" ||
        request.url === "/api/auth/session"
      ) {
        return;
      }
      if (!hasSession(request)) throw errors.authRequired();
    });

    app.post("/api/auth/session", async (request, reply) => {
      if (remoteAccess && !hasSession(request) && !hasBearer(request)) {
        throw errors.authRequired("远程访问需要通过 URL fragment 提供 OSHEEP_AUTH_TOKEN");
      }

      const secure = remoteAccess ? "; Secure" : "";
      reply.header("cache-control", "no-store");
      reply.header(
        "set-cookie",
        `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict${secure}`,
      );
      return { ok: true };
    });
  };

  return { isTrustedOrigin, register };
}
