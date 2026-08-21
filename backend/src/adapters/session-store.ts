import { randomUUID } from "node:crypto";
import { AdapterError } from "./errors.js";
import type { AdapterSession, OsheepSession } from "./types.js";

const sessions = new Map<string, AdapterSession>();
export function createOsheepSession(
  adapterId: string,
  kind: OsheepSession["kind"],
  input: Partial<OsheepSession> = {},
): OsheepSession {
  const now = Date.now();
  return {
    id: input.id ?? randomUUID(),
    adapterId,
    kind,
    state: input.state ?? "starting",
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    metadata: input.metadata ?? {},
    nativeSessionId: input.nativeSessionId,
  };
}
export function saveAdapterSession(session: AdapterSession): void {
  sessions.set(session.session.id, session);
}
export function getAdapterSession(id: string): AdapterSession {
  const session = sessions.get(id);
  if (!session)
    throw new AdapterError("SESSION_NOT_FOUND", `Adapter session not found: ${id}`, {
      sessionId: id,
    });
  return session;
}
export function deleteAdapterSession(id: string): void {
  sessions.delete(id);
}
export function listAdapterSessions(): AdapterSession[] {
  return [...sessions.values()];
}
