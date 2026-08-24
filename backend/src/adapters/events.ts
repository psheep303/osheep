import { randomUUID } from "node:crypto";
import type { AdapterEvent, AdapterEventBase, AgentState, AgentWaitingReason } from "./types.js";

export function createAdapterEvent<T extends AdapterEvent["type"]>(
  base: Pick<AdapterEventBase, "sessionId" | "adapterId">,
  type: T,
  data: Record<string, unknown> = {},
  sequence = 0,
): AdapterEvent {
  return {
    id: randomUUID(),
    sequence,
    timestamp: Date.now(),
    ...base,
    type,
    ...data,
  } as AdapterEvent;
}
export function mapAgentStateEvent(
  state: AgentState,
  base: Pick<AdapterEventBase, "sessionId" | "adapterId">,
  sequence: number,
  error?: string,
): AdapterEvent {
  if (state === "completed")
    return createAdapterEvent(base, "agent.completed", { state }, sequence);
  if (state === "failed")
    return createAdapterEvent(base, "agent.failed", { state, error }, sequence);
  if (state === "waiting")
    return createAdapterEvent(
      base,
      "agent.waiting",
      { state, reason: "unknown" satisfies AgentWaitingReason },
      sequence,
    );
  return createAdapterEvent(base, "session.started", { state }, sequence);
}

export function parseJsonlEvents(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    try {
      values.push(JSON.parse(value));
    } catch {
      /* ignore non-JSON diagnostics */
    }
  }
  return values;
}
