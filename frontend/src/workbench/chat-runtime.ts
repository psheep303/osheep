// Single-source-of-truth for an osheep code turn that keeps running even
// after the user closes the chat tab. Components subscribe via
// `useChatTurn(sessionId)` — unmounting just removes the listener; the turn
// itself only stops when the user explicitly hits the stop button or the
// browser tab is closed.

import {
  aiChatStreamOsheepCode,
  execRead,
  execRun,
  execWrite,
  saveSession as apiSaveSession,
  type AiChatMessage,
  type ChatMessage,
  type ChatStep,
  type ReadArgs,
  type RunArgs,
  type SessionRecord,
  type ToolKind,
  type WriteArgs,
} from "./api";
import { buildOsheepCodePrompt, detectPlatform } from "./osheep-code-prompt";
import {
  classifyCommand,
  type RunCategory,
  type CategoryDescriptor,
  RUN_CATEGORIES,
} from "./run-classify";
import {
  detectReasoningKind,
  type AiAutoAllow,
  type AiProvider,
  type ReasoningEffort,
} from "./settings";

const MAX_TOOL_LOOPS = 8;

export type ConfirmDecision = "once" | "always" | "deny";

export interface PendingToolConfirm {
  call: { id: string; tool: ToolKind; args: unknown };
  category: CategoryDescriptor;
  resolve: (d: ConfirmDecision) => void;
}

export type TurnStatus =
  | "idle"
  | "running"
  | "awaiting-confirm"
  | "error";

export interface TurnView {
  sessionId: string;
  workspaceId: string;
  status: TurnStatus;
  /** Steps for the current pending assistant reply (not yet persisted). */
  pendingSteps: ChatStep[];
  /** Free text accumulating in the current pending reply. */
  pendingText: string;
  /** Confirmation request currently blocking the loop, if any. */
  pendingConfirm: PendingToolConfirm | null;
  /** Last error from the most recent turn, sticky until next send. */
  error: string | null;
}

interface TurnInternal extends TurnView {
  abortRef: AbortController | null;
  listeners: Set<() => void>;
  busy: boolean;
  /** Cached snapshot for useSyncExternalStore identity. Cleared by notify(). */
  viewCache: TurnView | null;
  /** Send queued while the previous turn was still aborting. Consumed in
   * the runTurn `finally` block. */
  queued: {
    provider: AiProvider;
    model: string;
    effort: ReasoningEffort | null;
    text: string;
  } | null;
}

/**
 * External callbacks the runtime needs back from the React layer.
 * These are set per-session when ChatTab subscribes — but the runtime keeps
 * the LAST set we received, so even after ChatTab unmounts we can still:
 *   - save the session record (writes go through the backend regardless)
 *   - update an external "active sessions" badge / refresh signal
 *   - propagate auto-allow toggles into the global settings store
 */
export interface RuntimeCallbacks {
  updateAutoAllow: (next: AiAutoAllow) => void;
  onSessionChanged: () => void;
  /** Latest snapshot of the session record, used to build api messages. */
  getSession: () => SessionRecord | null;
  /** Apply a saved session record back into React state. */
  setSession: (next: SessionRecord) => void;
  /** Current autoAllow state from settings. */
  getAutoAllow: () => AiAutoAllow;
}

interface SendInput {
  workspaceId: string;
  provider: AiProvider;
  model: string;
  effort: ReasoningEffort | null;
  text: string;
  callbacks: RuntimeCallbacks;
}

class ChatRuntime {
  private turns = new Map<string, TurnInternal>();
  private idleCache = new Map<string, TurnView>();

  /** Last callbacks set per session so off-tab listeners still get updates. */
  private cbs = new Map<string, RuntimeCallbacks>();

  /** Sidebar / panel listeners that observe global activity (any-turn changed). */
  private globalListeners = new Set<() => void>();

  /** Snapshot view for a session — never mutate. Cached for referential
   * stability so useSyncExternalStore doesn't loop. */
  getView(sessionId: string): TurnView {
    const t = this.turns.get(sessionId);
    if (!t) {
      let cached = this.idleCache.get(sessionId);
      if (!cached) {
        cached = idleView(sessionId);
        this.idleCache.set(sessionId, cached);
      }
      return cached;
    }
    if (t.viewCache) return t.viewCache;
    t.viewCache = {
      sessionId: t.sessionId,
      workspaceId: t.workspaceId,
      status: t.status,
      pendingSteps: t.pendingSteps,
      pendingText: t.pendingText,
      pendingConfirm: t.pendingConfirm,
      error: t.error,
    };
    return t.viewCache;
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let t = this.turns.get(sessionId);
    if (!t) {
      t = makeInternal(sessionId, "");
      this.turns.set(sessionId, t);
    }
    t.listeners.add(listener);
    return () => {
      const cur = this.turns.get(sessionId);
      if (cur) {
        cur.listeners.delete(listener);
        // Don't garbage-collect — even with zero listeners we keep the turn
        // alive so reopening the tab shows live progress.
      }
    };
  }

  isBusy(sessionId: string): boolean {
    const t = this.turns.get(sessionId);
    return !!t && (t.status === "running" || t.status === "awaiting-confirm");
  }

  /** Sessions with active background work (for sidebar status dots). */
  activeSessionIds(): string[] {
    const ids: string[] = [];
    for (const [id, t] of this.turns) {
      if (t.status === "running" || t.status === "awaiting-confirm") ids.push(id);
    }
    return ids;
  }

  subscribeActivity(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  setCallbacks(sessionId: string, cb: RuntimeCallbacks): void {
    this.cbs.set(sessionId, cb);
  }

  /** Stop the active stream for a session, if any. */
  stop(sessionId: string): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    try {
      t.abortRef?.abort();
    } catch {
      /* ignore */
    }
  }

  /** Resolve a pending tool confirmation. */
  resolveConfirm(sessionId: string, decision: ConfirmDecision): void {
    const t = this.turns.get(sessionId);
    if (!t || !t.pendingConfirm) return;
    const pc = t.pendingConfirm;
    t.pendingConfirm = null;
    t.status = t.busy ? "running" : "idle";
    this.notify(t);
    pc.resolve(decision);
  }

  clearError(sessionId: string): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    t.error = null;
    this.notify(t);
  }

  /**
   * Send a user message and run the multi-step tool loop in the background.
   * Returns immediately; subscribers will see state mutate via notify().
   *
   * If a previous turn is still in flight (busy), the new send is queued
   * and the current run is aborted — the queued payload fires from the
   * `finally` block of `runTurn` once the old loop unwinds. This lets the
   * user interrupt a running task with a new prompt from the composer.
   */
  send(input: SendInput): void {
    const { workspaceId, provider, model, effort, text, callbacks } = input;
    const sessionId = callbacks.getSession()?.id ?? "";
    if (!sessionId) return;

    this.setCallbacks(sessionId, callbacks);

    let t = this.turns.get(sessionId);
    if (!t) {
      t = makeInternal(sessionId, workspaceId);
      this.turns.set(sessionId, t);
    }
    if (t.busy) {
      // Queue the payload and abort the in-flight run. The runTurn finally
      // block will drain `queued` and re-enter.
      t.queued = { provider, model, effort, text };
      // If we're stuck on a tool-confirm prompt, resolve as deny so the
      // current turn unwinds promptly.
      if (t.pendingConfirm) {
        const pc = t.pendingConfirm;
        t.pendingConfirm = null;
        pc.resolve("deny");
      }
      try {
        t.abortRef?.abort();
      } catch {
        /* ignore */
      }
      return;
    }

    t.workspaceId = workspaceId;
    t.status = "running";
    t.error = null;
    t.pendingSteps = [];
    t.pendingText = "";
    t.busy = true;
    this.notify(t);

    void this.runTurn(t, provider, model, effort, text);
  }

  private async runTurn(
    t: TurnInternal,
    provider: AiProvider,
    model: string,
    effort: ReasoningEffort | null,
    text: string
  ): Promise<void> {
    const sessionId = t.sessionId;
    const cb = this.cbs.get(sessionId);
    if (!cb) {
      t.busy = false;
      t.status = "idle";
      this.notify(t);
      return;
    }

    const initial = cb.getSession();
    if (!initial) {
      t.busy = false;
      t.status = "idle";
      this.notify(t);
      return;
    }

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    const nextTitle =
      initial.title === "新对话" || !initial.title
        ? text.slice(0, 24)
        : initial.title;

    let working: SessionRecord = {
      ...initial,
      title: nextTitle,
      providerId: provider.id,
      model,
      messages: [...initial.messages, userMsg],
    };
    // Persist the user message immediately so reopening the tab mid-turn
    // shows the request that's currently being processed.
    try {
      const saved = await apiSaveSession(t.workspaceId, working);
      working = saved;
    } catch {
      /* tolerate — runtime keeps `working` and re-saves at the end */
    }
    cb.setSession(working);
    cb.onSessionChanged();

    const sysPrompt = buildOsheepCodePrompt({
      workspaceId: t.workspaceId,
      platform: detectPlatform(),
      nowIso: new Date().toISOString(),
    });

    // Mutating accumulators captured by stream callbacks so we get a single
    // source of truth across loops.
    const commitSteps = (next: ChatStep[]) => {
      t.pendingSteps = next;
      this.notify(t);
    };
    const commitText = (next: string) => {
      t.pendingText = next;
      this.notify(t);
    };

    let userAborted = false;

    // Track tool-call signatures already executed in this user turn.
    // If the model re-requests an identical (tool, args) call, we short-circuit
    // it with a synthetic tool-result that tells the model it's looping —
    // this prevents the "read the same file 10 times" failure mode.
    const calledSigs = new Set<string>();
    const toolSig = (tool: string, args: unknown) => {
      try {
        return `${tool}::${JSON.stringify(args ?? {})}`;
      } catch {
        return `${tool}::<unserializable>`;
      }
    };

    try {
      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop += 1) {
        const apiMessages: AiChatMessage[] = [
          { role: "system", content: sysPrompt },
        ];
        for (const m of working.messages) {
          if (m.role === "tool") {
            apiMessages.push({
              role: "tool",
              content: m.content,
              tool_call_id: m.tool_call_id,
            });
          } else {
            apiMessages.push({ role: m.role, content: m.content });
          }
        }

        const ac = new AbortController();
        t.abortRef = ac;

        const toolsThisRound: Extract<ChatStep, { kind: "tool" }>[] = [];

        const { aborted } = await aiChatStreamOsheepCode(
          t.workspaceId,
          {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model,
            messages: apiMessages,
            kind: provider.kind,
            reasoning: effort ? { effort } : undefined,
          },
          {
            onPlan: (items) => {
              commitSteps([...t.pendingSteps, { kind: "plan", items }]);
            },
            onThoughtStart: (id) => {
              commitSteps([
                ...t.pendingSteps,
                { kind: "thought", id, text: "" },
              ]);
            },
            onThoughtDelta: (id, chunk) => {
              const cur = t.pendingSteps;
              const idx = [...cur].reverse().findIndex(
                (s) => s.kind === "thought" && s.id === id
              );
              if (idx === -1) return;
              const real = cur.length - 1 - idx;
              const next = cur.slice();
              const node = next[real] as Extract<ChatStep, { kind: "thought" }>;
              next[real] = { ...node, text: node.text + chunk };
              commitSteps(next);
            },
            onThoughtEnd: () => {
              /* nothing — text already in place */
            },
            onTextDelta: (chunk) => {
              commitText(t.pendingText + chunk);
            },
            onVerify: (txt) => {
              commitSteps([...t.pendingSteps, { kind: "verify", text: txt }]);
            },
            onToolCall: (call) => {
              const step: Extract<ChatStep, { kind: "tool" }> = {
                kind: "tool",
                id: call.id,
                tool: call.tool,
                args: call.args,
                status: "running",
              };
              toolsThisRound.push(step);
              commitSteps([...t.pendingSteps, step]);
            },
          },
          ac.signal
        );
        t.abortRef = null;

        if (aborted) {
          userAborted = true;
          break;
        }

        if (toolsThisRound.length === 0) break;

        // If the user already queued a new send (which sets t.queued and
        // aborts the stream), abandon the rest of this turn so the queued
        // payload can take over from the finally-block.
        if (t.queued) break;

        for (const step of toolsThisRound) {
          // Bail mid-batch if the user queued a new send — otherwise we'd
          // keep executing or confirming the remaining tools from a turn the
          // user no longer cares about.
          if (t.queued) break;

          // Short-circuit duplicate tool calls within the same user turn.
          // The previous result is already in the conversation, so re-running
          // wastes time and usually signals the model is stuck in a loop.
          const sig = toolSig(step.tool, step.args);
          if (calledSigs.has(sig)) {
            const dupMsg =
              "重复调用已跳过：本轮中已用相同参数调用过该工具，结果已在上文。请选择不同的动作或结束本轮。";
            const newSteps = t.pendingSteps.map((s) =>
              s.kind === "tool" && s.id === step.id
                ? { ...s, status: "denied" as const, error: dupMsg }
                : s
            );
            commitSteps(newSteps);
            working = {
              ...working,
              messages: [
                ...working.messages,
                {
                  role: "tool",
                  tool_call_id: step.id,
                  content: `[skipped duplicate ${step.tool} call: identical arguments to a previous call this turn. Do not repeat. Pick a different action or stop.]`,
                  timestamp: Date.now(),
                },
              ],
            };
            continue;
          }
          calledSigs.add(sig);

          const autoAllow = cb.getAutoAllow();
          const category = pickCategory(step);
          // For read/write tools we always gate on `read`/`write`; for run
          // we gate on the granular run-* key the classifier picked.
          const allowKey: keyof AiAutoAllow =
            step.tool === "read"
              ? "read"
              : step.tool === "write"
              ? "write"
              : (category.autoAllowKey as keyof AiAutoAllow);
          const allowed = !!autoAllow[allowKey];

          let decision: ConfirmDecision = allowed ? "always" : "deny";
          if (!allowed) {
            decision = await new Promise<ConfirmDecision>((resolve) => {
              t.pendingConfirm = {
                call: { id: step.id, tool: step.tool, args: step.args },
                category,
                resolve,
              };
              t.status = "awaiting-confirm";
              this.notify(t);
            });
            if (decision === "always") {
              const nextAllow = { ...autoAllow, [allowKey]: true };
              cb.updateAutoAllow(nextAllow);
            }
          }

          if (decision === "deny") {
            const newSteps = t.pendingSteps.map((s) =>
              s.kind === "tool" && s.id === step.id
                ? { ...s, status: "denied" as const, error: "user denied" }
                : s
            );
            commitSteps(newSteps);
            working = {
              ...working,
              messages: [
                ...working.messages,
                {
                  role: "tool",
                  tool_call_id: step.id,
                  content: `[denied by user]`,
                  timestamp: Date.now(),
                },
              ],
            };
            continue;
          }

          try {
            let resultPayload: unknown;
            if (step.tool === "read") {
              resultPayload = await execRead(t.workspaceId, step.args as ReadArgs);
            } else if (step.tool === "write") {
              resultPayload = await execWrite(t.workspaceId, step.args as WriteArgs);
            } else {
              resultPayload = await execRun(t.workspaceId, step.args as RunArgs);
            }
            const newSteps = t.pendingSteps.map((s) =>
              s.kind === "tool" && s.id === step.id
                ? { ...s, status: "ok" as const, result: resultPayload }
                : s
            );
            commitSteps(newSteps);
            working = {
              ...working,
              messages: [
                ...working.messages,
                {
                  role: "tool",
                  tool_call_id: step.id,
                  content: stringifyToolResult(step.tool, resultPayload),
                  timestamp: Date.now(),
                },
              ],
            };
          } catch (e) {
            const msg = (e as Error).message;
            const newSteps = t.pendingSteps.map((s) =>
              s.kind === "tool" && s.id === step.id
                ? { ...s, status: "err" as const, error: msg }
                : s
            );
            commitSteps(newSteps);
            working = {
              ...working,
              messages: [
                ...working.messages,
                {
                  role: "tool",
                  tool_call_id: step.id,
                  content: `[error] ${msg}`,
                  timestamp: Date.now(),
                },
              ],
            };
          }
        }
      }

      const finalText = collapseFinalText(t.pendingSteps, t.pendingText);
      const finalSteps = t.pendingSteps;
      if (finalSteps.length === 0 && !finalText.trim() && !userAborted) {
        t.error =
          "上游未返回任何内容，请检查模型 ID、Base URL 或上游兼容性（看后端日志可获取详情）";
        // Clear pending state BEFORE we hand control to React so the tab
        // never paints "pending steps + saved message" together.
        t.pendingSteps = [];
        t.pendingText = "";
        try {
          const saved = await apiSaveSession(t.workspaceId, working);
          cb.setSession(saved);
        } catch {
          cb.setSession(working);
        }
        cb.onSessionChanged();
      } else {
        const replyMsg: ChatMessage = {
          role: "assistant",
          content: finalText,
          timestamp: Date.now(),
          steps: finalSteps,
        };
        working = {
          ...working,
          messages: [...working.messages, replyMsg],
        };
        t.pendingSteps = [];
        t.pendingText = "";
        try {
          const saved = await apiSaveSession(t.workspaceId, working);
          cb.setSession(saved);
        } catch {
          cb.setSession(working);
        }
        cb.onSessionChanged();
      }
    } catch (e) {
      t.error = (e as Error).message;
      try {
        const saved = await apiSaveSession(t.workspaceId, working);
        cb.setSession(saved);
        cb.onSessionChanged();
      } catch {
        /* ignore */
      }
    } finally {
      t.pendingSteps = [];
      t.pendingText = "";
      t.pendingConfirm = null;
      t.abortRef = null;
      t.busy = false;
      t.status = t.error ? "error" : "idle";
      // Drain any send that was queued while we were aborting.
      const queued = t.queued;
      t.queued = null;
      this.notify(t);
      if (queued) {
        // Start the queued turn directly — `send()` would early-out here
        // because we're already inside this function; bypass it by going
        // through the same setup as the main `send` path.
        t.workspaceId = t.workspaceId;
        t.status = "running";
        t.error = null;
        t.busy = true;
        this.notify(t);
        void this.runTurn(
          t,
          queued.provider,
          queued.model,
          queued.effort,
          queued.text
        );
      }
    }
  }

  private notify(t: TurnInternal): void {
    t.viewCache = null;
    for (const fn of t.listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    for (const fn of this.globalListeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }
}

function makeInternal(sessionId: string, workspaceId: string): TurnInternal {
  return {
    sessionId,
    workspaceId,
    status: "idle",
    pendingSteps: [],
    pendingText: "",
    pendingConfirm: null,
    error: null,
    abortRef: null,
    listeners: new Set(),
    busy: false,
    viewCache: null,
    queued: null,
  };
}

function idleView(sessionId: string): TurnView {
  return {
    sessionId,
    workspaceId: "",
    status: "idle",
    pendingSteps: [],
    pendingText: "",
    pendingConfirm: null,
    error: null,
  };
}

function pickCategory(step: Extract<ChatStep, { kind: "tool" }>): CategoryDescriptor {
  if (step.tool === "read") {
    return {
      key: "other" as RunCategory,
      label: "Read",
      hint: "读取文件 / 列目录 / 搜索",
      // `read` lives in autoAllow but isn't a run-* key; the runtime knows
      // to use the tool's own key in that case (see `toolAutoAllowKey`).
      autoAllowKey: "runOther",
    };
  }
  if (step.tool === "write") {
    return {
      key: "other" as RunCategory,
      label: "Write",
      hint: "写入 / 创建 / 删除 / 重命名",
      autoAllowKey: "runOther",
    };
  }
  // run — classify by command string
  const args = step.args as { command?: string } | undefined;
  const cmd = typeof args?.command === "string" ? args.command : "";
  const cat: RunCategory = classifyCommand(cmd);
  return RUN_CATEGORIES[cat];
}

function stringifyToolResult(t: ToolKind, result: unknown): string {
  if (t === "run") {
    const r = result as {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      signal?: string | null;
      truncated?: boolean;
    };
    return JSON.stringify(
      {
        exitCode: r.exitCode ?? null,
        signal: r.signal ?? null,
        stdout: clipText(r.stdout ?? "", 16_000),
        stderr: clipText(r.stderr ?? "", 4_000),
        truncated: r.truncated ?? false,
      },
      null,
      2
    );
  }
  if (t === "read") {
    const r = result as { kind?: string; content?: string } & Record<string, unknown>;
    if (r.kind === "file" && typeof r.content === "string") {
      return clipText(r.content, 32_000);
    }
    return JSON.stringify(r);
  }
  return JSON.stringify(result);
}

function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

function collapseFinalText(steps: ChatStep[], extraText: string): string {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i]!;
    if (s.kind === "verify") return s.text;
  }
  return extraText.trim();
}

// React hook — kept in this module to keep the runtime + binding together.
import { useSyncExternalStore } from "react";

export const chatRuntime = new ChatRuntime();

export function useChatTurn(sessionId: string): TurnView {
  return useSyncExternalStore(
    (cb) => chatRuntime.subscribe(sessionId, cb),
    () => chatRuntime.getView(sessionId),
    () => chatRuntime.getView(sessionId)
  );
}

let lastActiveSnapshot: string[] = [];
function getActiveSnapshot(): string[] {
  const next = chatRuntime.activeSessionIds().sort();
  // Cache the snapshot so useSyncExternalStore can identity-compare.
  if (
    lastActiveSnapshot.length === next.length &&
    lastActiveSnapshot.every((v, i) => v === next[i])
  ) {
    return lastActiveSnapshot;
  }
  lastActiveSnapshot = next;
  return next;
}

/** Hook for the AI panel sidebar: returns the live set of active session ids. */
export function useActiveSessions(): Set<string> {
  const ids = useSyncExternalStore(
    (cb) => chatRuntime.subscribeActivity(cb),
    getActiveSnapshot,
    getActiveSnapshot
  );
  return new Set(ids);
}

// Helper re-export for callers that don't want a second import.
export { detectReasoningKind };
