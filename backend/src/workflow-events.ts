import type { WorkflowNode, WorkflowRun } from "./workflows.js";

export type WorkflowRuntimeEvent =
  | { type: "ready"; updatedAt: number }
  | { type: "node"; updatedAt: number; node: WorkflowNode }
  | { type: "run"; updatedAt: number; run: WorkflowRun };

export type GlobalWorkflowRuntimeEvent = WorkflowRuntimeEvent & { workflowId: string };

type WorkflowRuntimeListener = (event: WorkflowRuntimeEvent) => void;

const listeners = new Map<string, Set<WorkflowRuntimeListener>>();
const workspaceListeners = new Map<string, Set<(event: GlobalWorkflowRuntimeEvent) => void>>();

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
  if (current) {
    for (const listener of current) {
      try {
        listener(event);
      } catch {
        // Runtime observers must never be able to fail the workflow they watch.
      }
    }
  }
  const workspaceCurrent = workspaceListeners.get(workspaceRoot);
  if (!workspaceCurrent) return;
  const globalEvent = { ...event, workflowId } as GlobalWorkflowRuntimeEvent;
  for (const listener of workspaceCurrent) {
    try {
      listener(globalEvent);
    } catch {
      // Runtime observers must never be able to fail the workflow they watch.
    }
  }
}

export function subscribeWorkspaceWorkflowRuntime(
  workspaceRoot: string,
  listener: (event: GlobalWorkflowRuntimeEvent) => void,
): () => void {
  const current = workspaceListeners.get(workspaceRoot) ?? new Set();
  current.add(listener);
  workspaceListeners.set(workspaceRoot, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) workspaceListeners.delete(workspaceRoot);
  };
}
