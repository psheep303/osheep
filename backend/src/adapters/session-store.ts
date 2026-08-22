import { randomUUID } from "node:crypto";
import { AdapterError } from "./errors.js";
import type { AdapterEvent, AdapterSession, OsheepSession } from "./types.js";

const sessions = new Map<string, AdapterSession>();
const eventListeners = new Set<(event: AdapterEvent) => void>();
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

export function subscribeAdapterEvents(listener: (event: AdapterEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function publishAdapterEvent(event: AdapterEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch {
      // Observers must never affect an adapter session.
    }
  }
}
