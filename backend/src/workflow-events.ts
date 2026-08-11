import type { WorkflowNode, WorkflowRun } from "./workflows.js";

export type WorkflowRuntimeEvent =
  | { type: "ready"; updatedAt: number }
  | { type: "node"; updatedAt: number; node: WorkflowNode }
  | { type: "run"; updatedAt: number; run: WorkflowRun };

type WorkflowRuntimeListener = (event: WorkflowRuntimeEvent) => void;

const listeners = new Map<string, Set<WorkflowRuntimeListener>>();

function eventKey(workspaceRoot: string, workflowId: string): string {
  return `${workspaceRoot}\0${workflowId}`;
}

export function subscribeWorkflowRuntime(
  workspaceRoot: string,
  workflowId: string,
  listener: WorkflowRuntimeListener,
): () => void {
  const key = eventKey(workspaceRoot, workflowId);
  const current = listeners.get(key) ?? new Set<WorkflowRuntimeListener>();
  current.add(listener);
  listeners.set(key, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

export function publishWorkflowRuntime(
  workspaceRoot: string,
  workflowId: string,
  event: WorkflowRuntimeEvent,
): void {
  const current = listeners.get(eventKey(workspaceRoot, workflowId));
  if (!current) return;
  for (const listener of current) {
    try {
      listener(event);
    } catch {
      // Runtime observers must never be able to fail the workflow they watch.
    }
  }
}
