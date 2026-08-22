import type {
  AgentEffort,
  AgentMode,
  ClaudePermissionMode,
  CodexApproval,
  CodexSandbox,
} from "../ai-terminal.js";
import type { WorkspaceInfo } from "../workspace.js";

export type AdapterKind = "agent" | "harness";
export type AdapterId = string;
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
  approval: "none" | "manual" | "native";
  interruption: "none" | "soft" | "hard";
  transport: "pty" | "http" | "sdk" | "hybrid";
  modelSelection: boolean;
  workingDirectory: boolean;
  usage: boolean;
}

export type ConfigFieldType = "text" | "select" | "number" | "boolean";
export interface AdapterConfigSchema {
  fields: Array<{
    key: string;
    label: string;
    type: ConfigFieldType;
    required?: boolean;
    secret?: boolean;
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
  /** Wait until the current turn exits. */
  wait?(): Promise<AgentStateSnapshot>;
}
export interface AgentAdapter {
  readonly id: AdapterId;
  readonly name: string;
  readonly version: string;
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
    | "session.interrupted"
    | "session.stopped"
    | "session.closed"
    | "agent.completed"
    | "agent.failed"
    | "assistant.message"
    | "assistant.delta"
    | "tool.started"
    | "tool.completed"
    | "approval.required"
    | "approval.resolved"
    | "agent.waiting"
    | "adapter.frame"
    | "adapter.diagnostic";
  state?: AgentState;
  reason?: string | AgentWaitingReason;
  error?: string;
  content?: string;
  frameType?: string;
  frameStatus?: string;
  frameSessionId?: string;
  toolName?: string;
  callId?: string;
  success?: boolean;
  approvalId?: string;
  approved?: boolean;
  [key: string]: unknown;
};

export interface AgentTransport {
  start(input: TransportStartInput): Promise<TransportProcess>;
  resume(input: TransportResumeInput): Promise<TransportProcess>;
}

export interface TransportStartInput {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}
export interface TransportResumeInput extends TransportStartInput {
  sessionId: string;
}
export interface TransportChunk {
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
}
export interface TransportResult {
  exitCode: number | null;
  signal?: string;
  error?: string;
}
export interface TransportProcess {
  send(input: string): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  stop(reason?: string): Promise<void>;
  subscribe(listener: (chunk: TransportChunk) => void): () => void;
  wait(): Promise<TransportResult>;
}

export interface EventMapperContext {
  sessionId: string;
  adapterId: string;
  nextSequence(): number;
}
export interface AdapterEventMapper<RawEvent = unknown> {
  parse(chunk: string): RawEvent[];
  map(event: RawEvent, context: EventMapperContext): AdapterEvent[];
  flush?(context: EventMapperContext): AdapterEvent[];
}

export interface AdapterUsageProvider {
  readSessionUsage(input: UsageInput): Promise<AgentUsage>;
}
export interface UsageInput {
  session: OsheepSession;
  workspace?: WorkspaceInfo | string;
  config?: Record<string, unknown>;
}
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  model?: string;
}

export type AdapterConfig = {
  model?: string;
  workingDirectory?: string;
  claudePermissionMode?: ClaudePermissionMode;
  codexApproval?: CodexApproval;
  codexSandbox?: CodexSandbox;
  effort?: AgentEffort;
  mode?: AgentMode;
};
