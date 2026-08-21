import type {
  AgentEffort,
  AgentMode,
  ClaudePermissionMode,
  CodexApproval,
  CodexSandbox,
} from "../ai-terminal.js";
import type { WorkspaceInfo } from "../workspace.js";

export type AdapterKind = "agent" | "harness";
export type AdapterId = "claude-code" | "codex" | string;
export type AgentState =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped"
  | "closed";
export type AgentWaitingReason = "approval" | "user-input" | "manual-success" | "unknown";

export interface OsheepSession {
  id: string;
  adapterId: string;
  kind: AdapterKind;
  nativeSessionId?: string;
  state: AgentState;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface AdapterCapabilities {
  streaming: boolean;
  structuredEvents: boolean;
  session: boolean;
  resume: boolean;
  multiTurn: boolean;
  approval: boolean;
  interruption: boolean;
  modelSelection: boolean;
  workingDirectory: boolean;
}

export type ConfigFieldType = "text" | "select" | "number" | "boolean";
export interface AdapterConfigSchema {
  fields: Array<{
    key: string;
    label: string;
    type: ConfigFieldType;
    required?: boolean;
    defaultValue?: unknown;
    options?: Array<{ value: string; label: string }>;
  }>;
}

export interface AdapterStartInput {
  workspace: WorkspaceInfo | string;
  model?: string;
  prompt: string;
  config?: Record<string, unknown>;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}
export interface AdapterResumeInput extends AdapterStartInput {
  sessionId: string;
}
export interface AdapterSendInput {
  prompt: string;
  config?: Record<string, unknown>;
  signal?: AbortSignal;
}
export interface AgentStateSnapshot {
  state: AgentState;
  reason?: AgentWaitingReason;
  error?: string;
  updatedAt: number;
}
export type AdapterEventListener = (event: AdapterEvent) => void;

export interface AdapterSession {
  readonly session: OsheepSession;
  send(input: AdapterSendInput): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  stop(reason?: string): Promise<void>;
  getState(): Promise<AgentStateSnapshot>;
  getSession(): Promise<OsheepSession>;
  subscribeEvents(listener: AdapterEventListener): () => void;
}
export interface AgentAdapter {
  readonly id: AdapterId;
  readonly name: string;
  readonly kind: AdapterKind;
  getCapabilities(): AdapterCapabilities;
  getConfigSchema(): AdapterConfigSchema;
  start(input: AdapterStartInput): Promise<AdapterSession>;
  resume(input: AdapterResumeInput): Promise<AdapterSession>;
}

export interface AdapterEventBase {
  id: string;
  sequence: number;
  timestamp: number;
  sessionId: string;
  adapterId: string;
}
export type AdapterEvent = AdapterEventBase & {
  type:
    | "session.started"
    | "session.resumed"
    | "session.closed"
    | "agent.completed"
    | "agent.failed"
    | "assistant.message"
    | "assistant.delta"
    | "tool.started"
    | "tool.completed"
    | "approval.required"
    | "approval.resolved"
    | "agent.waiting";
  state?: AgentState;
  reason?: AgentWaitingReason;
  error?: string;
  content?: string;
  [key: string]: unknown;
};

export type AdapterConfig = {
  model?: string;
  workingDirectory?: string;
  claudePermissionMode?: ClaudePermissionMode;
  codexApproval?: CodexApproval;
  codexSandbox?: CodexSandbox;
  effort?: AgentEffort;
  mode?: AgentMode;
};
