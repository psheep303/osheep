// Single-source-of-truth for an osheep code turn that keeps running even
// after the user closes the chat tab. Components subscribe via
// `useChatTurn(sessionId)` — unmounting just removes the listener; the turn
// itself only stops when the user explicitly hits the stop button or the
// browser tab is closed.

import {
  type AiChatMessage,
  ApiClientError,
  aiChatStream,
  aiChatStreamOsheepCode,
  saveSession as apiSaveSession,
  type ChatMessage,
  type ChatStep,
  execRead,
  execRun,
  execWrite,
  type ReadArgs,
  type RunArgs,
  type RunResult,
  type SessionRecord,
  type ToolKind,
  type WriteArgs,
} from "./api";
import { buildOsheepCodePrompt, detectPlatform } from "./osheep-code-prompt";
import {
  type CategoryDescriptor,
  classifyCommand,
  RUN_CATEGORIES,
  type RunCategory,
} from "./run-classify";
import {
  type AiAutoAllow,
  type AiProvider,
  detectReasoningKind,
  isCliProviderKind,
  type ReasoningEffort,
} from "./settings";

const MAX_TOOL_LOOPS = 40;

/**
 * Consecutive no-progress rounds (a round whose single tool action failed or
 * did nothing new) after which we stop the turn instead of grinding all the
 * way to MAX_TOOL_LOOPS. Keeps a model that never emits valid <tasks> — or
 * keeps failing the same call — from spamming the timeline.
 */
const NO_PROGRESS_LIMIT = 3;

/**
 * Tool-confirm decision returned by the UI to the runtime.
 *
 * Surface:
 *  - "allow"  — run this tool call now (no autoAllow change — the user can
 *               toggle persistent allowance only from the auto-allow panel).
 *  - "deny"   — refuse, pass `[denied by user]` back to the model.
 *  - { kind: "feedback", text } — refuse but include the user's freeform
 *    instruction so the model can change direction without a full turn
 *    abort. Shown to the model as `[denied by user: <text>]`.
 *
 * The legacy "always" decision was removed when the inline approval bar was
 * simplified to "是 / 否 / 其他". Auto-allow toggles live solely in the
 * Auto-allow panel now.
 */
export type ConfirmDecision = "allow" | "deny" | { kind: "feedback"; text: string };

export interface PendingToolConfirm {
  call: { id: string; tool: ToolKind; args: unknown };
  category: CategoryDescriptor;
  resolve: (d: ConfirmDecision) => void;
}

export type TurnStatus = "idle" | "running" | "awaiting-confirm" | "error";

export interface TurnView {
  sessionId: string;
  workspaceId: string;
  status: TurnStatus;
  /**
   * Steps for the current pending assistant reply (not yet persisted). Free
   * text the model emits between/after tool calls is interleaved here as
   * `kind:"text"` steps — there is no separate always-at-bottom text bubble,
   * so the timeline stays strictly one-node-after-another.
   */
  pendingSteps: ChatStep[];
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

interface TasksState {
  hasValidTasks: boolean;
  lastNormalizedTasks: string;
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
  /**
   * Fired after a tool mutates the workspace — a successful `write` of any
   * kind, or any `run` command (shell commands may create/delete files). The
   * workbench refreshes the file explorer + git decorations in response.
   */
  onFilesChanged?: () => void;
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
    if (!t?.pendingConfirm) return;
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
    t.busy = true;
    this.notify(t);

    void this.runTurn(t, provider, model, effort, text);
  }

  private async runTurn(
    t: TurnInternal,
    provider: AiProvider,
    model: string,
    effort: ReasoningEffort | null,
    text: string,
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
      initial.title === "新对话" || !initial.title ? text.slice(0, 24) : initial.title;

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
    const appendTextStep = (chunk: string) => {
      if (!chunk) return;
      const prev = t.pendingSteps[t.pendingSteps.length - 1];
      if (prev?.kind === "text") {
        const next = t.pendingSteps.slice();
        next[next.length - 1] = { ...prev, text: prev.text + chunk };
        commitSteps(next);
        return;
      }
      commitSteps([...t.pendingSteps, { kind: "text", text: chunk }]);
    };

    let modelTranscript: ChatMessage[] = [...working.messages];

    const tasksState: TasksState = {
      hasValidTasks: false,
      lastNormalizedTasks: "",
    };

    const upsertTasks = (items: string[]) => {
      const normalizedItems = normalizeTasksItems(items);
      const normalized = normalizedItems.join("\n").trim();
      if (!normalized) return;
      if (normalized === tasksState.lastNormalizedTasks) return;

      const nextStep: ChatStep = { kind: "plan", items: normalizedItems };
      tasksState.hasValidTasks = true;
      tasksState.lastNormalizedTasks = normalized;
      commitSteps([...t.pendingSteps, nextStep]);
    };

    const upsertThought = (id: string, text: string, ended: boolean) => {
      const now = Date.now();
      const idx = t.pendingSteps.findIndex((s) => s.kind === "thought" && s.id === id);
      if (idx >= 0) {
        const next = t.pendingSteps.slice();
        const prev = next[idx] as Extract<ChatStep, { kind: "thought" }>;
        next[idx] = {
          ...prev,
          text,
          endedAt: ended ? now : prev.endedAt,
        };
        commitSteps(next);
        return;
      }
      commitSteps([
        ...t.pendingSteps,
        {
          kind: "thought",
          id,
          text,
          startedAt: now,
          endedAt: ended ? now : undefined,
        },
      ]);
    };

    const appendToolResult = (toolCallId: string, content: string) => {
      modelTranscript = [
        ...modelTranscript,
        {
          role: "tool",
          tool_call_id: toolCallId,
          content,
          timestamp: Date.now(),
        },
      ];
    };

    let userAborted = false;
    /** Synthetic exit note appended to the timeline when we stop the turn for
     * a non-error reason (loop limit reached, cached-repeat circuit broken).
     * Rendered as a normal text step so it sits cleanly in the conversation. */
    let exitNote: string | null = null;
    /** Loop iterations actually executed. Used by the final exit-note logic
     * to decide between "hit the 24-round budget" and "model gave up early". */
    let loopsRun = 0;
    /** Consecutive rounds that made no progress (failed / did nothing new).
     * Reset on a successful tool. Drives the NO_PROGRESS_LIMIT circuit breaker
     * so a misbehaving model stops cleanly instead of looping to the cap. */
    let noProgressRounds = 0;
    /** Set when the model emitted assistant tokens this round but no tools
     * and no verify — i.e. it stopped mid-task with a thought/plan and
     * nothing actionable. Surfaced as a distinct exit note. */
    let earlyGiveUp = false;

    // Track tool-call results in this user turn. If the model re-requests an
    // identical (tool, args) call, replay the previous result to the model
    // instead of showing a false failure or executing the tool again.
    const toolResultCache = new Map<string, ToolOutcome>();
    /** Ordered log of every tool call we actually executed (or short-circuited
     * because of cache hits / denies) this turn. We use this to inject a
     * "<recent-tool-calls-this-turn>" reminder into the prompt on every round
     * after the first, so the model has explicit, easy-to-skim signal about
     * what's already been done and shouldn't be re-emitted. */
    const executedTools: Array<{
      tool: ToolKind;
      args: unknown;
      status: "ok" | "err" | "denied" | "cached";
    }> = [];
    const toolSig = (tool: string, args: unknown) => {
      try {
        return `${tool}::${stableStringify(args ?? {})}`;
      } catch {
        return `${tool}::<unserializable>`;
      }
    };

    try {
      if (isCliProviderKind(provider.kind)) {
        const ac = new AbortController();
        t.abortRef = ac;
        const { aborted } = await aiChatStream(
          t.workspaceId,
          {
            model,
            messages: buildCliTurnMessages(working.messages),
            kind: provider.kind,
          },
          appendTextStep,
          ac.signal,
        );
        t.abortRef = null;
        cb.onFilesChanged?.();

        const finalText = collapseFinalText(t.pendingSteps);
        const finalSteps = t.pendingSteps;
        if (finalSteps.length === 0 && !finalText.trim() && !aborted) {
          t.error =
            "CLI did not return any output. Check that the selected CLI is installed and logged in.";
          t.pendingSteps = [];
          try {
            const saved = await apiSaveSession(t.workspaceId, working);
            cb.setSession(saved);
          } catch {
            cb.setSession(working);
          }
          cb.onSessionChanged();
        } else if (finalSteps.length > 0 || finalText.trim()) {
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
          try {
            const saved = await apiSaveSession(t.workspaceId, working);
            cb.setSession(saved);
          } catch {
            cb.setSession(working);
          }
          cb.onSessionChanged();
        }
        return;
      }

      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop += 1) {
        loopsRun = loop + 1;
        const apiMessages: AiChatMessage[] = [{ role: "system", content: sysPrompt }];
        for (const m of modelTranscript) {
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
        // From round 2 onward, append a synthetic system reminder listing
        // every tool call we've already executed this turn. The text-tag
        // protocol doesn't get the native "I emitted this tool_use" signal
        // that Claude Code's native tool_use protocol provides, so the model
        // sometimes forgets and re-emits identical calls. Surfacing them
        // explicitly drops repeat-rate close to zero.
        if (executedTools.length > 0) {
          apiMessages.push({
            role: "system",
            content: buildRecentToolsReminder(executedTools),
          });
        }

        const ac = new AbortController();
        t.abortRef = ac;

        const toolsThisRound: Extract<ChatStep, { kind: "tool" }>[] = [];

        const { rawAcc, aborted } = await aiChatStreamOsheepCode(
          t.workspaceId,
          {
            model,
            messages: apiMessages,
            kind: provider.kind,
            reasoning: effort ? { effort } : undefined,
          },
          {
            onPlan: (items) => {
              // Display all content even after a tool is accepted
              upsertTasks(items);
            },
            onThought: (id, thoughtText) => {
              // Display all content even after a tool is accepted
              upsertThought(id, thoughtText, true);
            },
            onThoughtStart: (id) => {
              // Display all content even after a tool is accepted
              // Placeholder node ("正在思考…") shown while the thought streams
              // upstream; onThought fills it atomically once the node closes.
              upsertThought(id, "", false);
            },
            onTextDelta: (chunk) => {
              // Display all content even after a tool is accepted
              appendTextStep(chunk);
            },
            onVerify: (txt) => {
              // Display all content even after a tool is accepted
              commitSteps([...t.pendingSteps, { kind: "verify", text: txt }]);
            },
            onAsk: (ask) => {
              // Display all content even after a tool is accepted
              // `<ask>` ends the turn (like <verify>): no further tools
              // execute. The UI in ChatTab renders an AskPanel under the
              // composer when the saved assistant message's last step is
              // kind: "ask" — see ai-panel.md.
              commitSteps([
                ...t.pendingSteps,
                {
                  kind: "ask",
                  id: ask.id,
                  question: ask.question,
                  options: ask.options,
                },
              ]);
            },
            onToolCall: (call) => {
              // Claude Code-style pacing: one thought → one action → one
              // result. If an upstream emits several tool blocks in one
              // message, keep only the first; the next model round can decide
              // the next action from the returned result.
              if (toolsThisRound.length > 0) return;
              const step: Extract<ChatStep, { kind: "tool" }> = {
                kind: "tool",
                // The tag parser restarts its id counter every round, so raw
                // call.id (e.g. "tc_2") collides across rounds. Prefix with the
                // loop index to keep ids unique within the whole turn —
                // otherwise the duplicate-drop filter below removes the earlier,
                // already-executed step that happens to share the id.
                id: `${loop}-${call.id}`,
                tool: call.tool,
                args: call.args,
                status: "queued",
              };
              toolsThisRound.push(step);
              commitSteps([...t.pendingSteps, step]);
            },
          },
          ac.signal,
        );
        t.abortRef = null;

        const assistantRawForTranscript =
          toolsThisRound.length > 0 ? truncateAssistantRawAfterFirstTool(rawAcc) : rawAcc;
        if (assistantRawForTranscript.trim()) {
          modelTranscript = [
            ...modelTranscript,
            {
              role: "assistant",
              content: assistantRawForTranscript,
              timestamp: Date.now(),
            },
          ];
        }

        if (aborted) {
          userAborted = true;
          break;
        }

        if (toolsThisRound.length === 0) {
          // Model returned without tool calls. If it also gave no <verify>
          // and no free text, that's an "early give-up" — flag it so the
          // exit-note logic below can show the right message.
          const hasVerify = t.pendingSteps.some((s) => s.kind === "verify");
          const hasAsk = t.pendingSteps.some((s) => s.kind === "ask");
          const hasFreeText = hasTextStep(t.pendingSteps);
          if (!hasVerify && !hasAsk && !hasFreeText) {
            earlyGiveUp = true;
          }
          break;
        }

        // If the user already queued a new send (which sets t.queued and
        // aborts the stream), abandon the rest of this turn so the queued
        // payload can take over from the finally-block.
        if (t.queued) break;

        // Did any tool actually execute this round? A round in which every
        // call was rejected by the tasks-gate, denied, a cached duplicate, or
        // an invalid-args error makes no progress — this drives the
        // NO_PROGRESS_LIMIT circuit breaker after the loop.
        let roundExecuted = false;

        for (const step of toolsThisRound) {
          // Bail mid-batch if the user queued a new send — otherwise we'd
          // keep executing or confirming the remaining tools from a turn the
          // user no longer cares about.
          if (t.queued) break;

          if (!tasksState.hasValidTasks) {
            const tasksMsg =
              "需要先输出 tasks：本轮还没有有效的 <tasks>，工具调用未执行。请先给出 Markdown checkbox tasks，再继续工具调用。";
            const newSteps = t.pendingSteps.map((s) =>
              s.kind === "tool" && s.id === step.id
                ? { ...s, status: "denied" as const, error: tasksMsg }
                : s,
            );
            commitSteps(newSteps);
            appendToolResult(
              step.id,
              `[tasks_required] Tool call was not executed because this turn has no valid <tasks>. Emit a markdown checkbox <tasks> first, then call tools.`,
            );
            continue;
          }

          // Short-circuit duplicate tool calls within the same user turn.
          // The model still gets the cached payload appended to its transcript
          // so it can continue without re-running the work. The duplicate step
          // is REMOVED from the timeline entirely — users only see the first,
          // real attempt; repeated emissions are silent. (We do NOT abort the
          // turn even if the model keeps re-emitting — MAX_TOOL_LOOPS is the
          // only loop budget that matters now.)
          const sig = toolSig(step.tool, step.args);
          const cachedOutcome = toolResultCache.get(sig);
          if (cachedOutcome) {
            const cachedPayload = makeCachedToolPayload(step.tool, cachedOutcome);
            // Drop the duplicate step from the timeline. onToolCall added it
            // when the tag was parsed; remove it now so the user never sees
            // it. The model transcript still contains this duplicate tool
            // emission and receives a cached tool result, so upstream state
            // stays consistent — only the rendered UI step is suppressed.
            commitSteps(t.pendingSteps.filter((s) => !(s.kind === "tool" && s.id === step.id)));
            appendToolResult(step.id, stringifyCachedToolResult(cachedPayload));
            executedTools.push({ tool: step.tool, args: step.args, status: "cached" });
            continue;
          }

          const validationError = validateToolCall(step);
          if (validationError) {
            const outcome = invalidToolOutcome(
              step.tool,
              validationError.code,
              validationError.message,
            );
            toolResultCache.set(sig, outcome);
            const newSteps = t.pendingSteps.map((s) =>
              s.kind === "tool" && s.id === step.id
                ? {
                    ...s,
                    status: outcome.status,
                    result: outcome.result,
                    error: outcome.error,
                  }
                : s,
            );
            commitSteps(newSteps);
            appendToolResult(step.id, outcome.toolResult);
            executedTools.push({ tool: step.tool, args: step.args, status: outcome.status });
            continue;
          }

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

          let decision: ConfirmDecision = allowed ? "allow" : "deny";
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
          }

          if (decision === "deny" || typeof decision === "object") {
            const feedback =
              typeof decision === "object" && decision.kind === "feedback"
                ? decision.text.trim()
                : "";
            const newSteps = t.pendingSteps.map((s) =>
              s.kind === "tool" && s.id === step.id
                ? {
                    ...s,
                    status: "denied" as const,
                    error: feedback ? `user instruction: ${feedback}` : "user denied",
                  }
                : s,
            );
            commitSteps(newSteps);
            appendToolResult(
              step.id,
              feedback ? `[denied by user: ${feedback}]` : `[denied by user]`,
            );
            executedTools.push({ tool: step.tool, args: step.args, status: "denied" });
            continue;
          }

          commitSteps(
            t.pendingSteps.map((s) =>
              s.kind === "tool" && s.id === step.id ? { ...s, status: "running" as const } : s,
            ),
          );
          const outcome = await executeToolCall(t.workspaceId, step);
          roundExecuted = true;
          toolResultCache.set(sig, outcome);
          const newSteps = t.pendingSteps.map((s) =>
            s.kind === "tool" && s.id === step.id
              ? {
                  ...s,
                  status: outcome.status,
                  result: outcome.result,
                  error: outcome.error,
                }
              : s,
          );
          commitSteps(newSteps);
          appendToolResult(step.id, outcome.toolResult);
          executedTools.push({ tool: step.tool, args: step.args, status: outcome.status });
          // A write that landed, or any run command (shell can create / delete
          // files), may have changed the workspace — ask the workbench to
          // refresh the file explorer + git decorations. read / denied /
          // invalid / cached calls never reach here.
          if (step.tool === "run" || (step.tool === "write" && outcome.status === "ok")) {
            cb.onFilesChanged?.();
          }
        }

        // No-progress circuit breaker. When a round executes no real tool —
        // every call was rejected by the tasks-gate, denied, a cached
        // duplicate, or an invalid-args error — it made no progress. After
        // NO_PROGRESS_LIMIT such rounds in a row, stop instead of grinding all
        // the way to MAX_TOOL_LOOPS. This is what keeps a model that never
        // emits a valid <tasks> (so every tool is rejected) from spamming the
        // timeline and burning the entire loop budget.
        if (!t.queued) {
          if (roundExecuted) {
            noProgressRounds = 0;
          } else {
            noProgressRounds += 1;
            if (noProgressRounds >= NO_PROGRESS_LIMIT) {
              exitNote = `**osheep code 已连续 ${NO_PROGRESS_LIMIT} 轮没有进展，自动停止本轮。** 这几轮里没有任何工具被真正执行（被拒绝 / 重复调用 / 参数无效）。最常见的原因是模型没有先输出有效的 <tasks> 块——在 <tasks> 之前的工具调用会被宿主拒绝。请补充更明确的指令后发送「继续」；若反复如此，建议更换更强的模型。`;
              break;
            }
          }
        }
        // The remaining outer-loop terminators are: model emits no tools, user
        // aborted, queued send, or MAX_TOOL_LOOPS exhausted.
      }

      // Final exit-note decision. Two distinct reasons we can stop the
      // turn without the model issuing <verify>:
      //   1. Model gave up early (returned plan/thought but no tool/verify)
      //   2. Loop budget exhausted (all MAX_TOOL_LOOPS rounds used tools)
      // Don't fire a note for cases that don't need one (user aborted, or
      // the model successfully concluded with verify/text).
      if (!userAborted && !exitNote) {
        const hasVerify = t.pendingSteps.some((s) => s.kind === "verify");
        const hasAsk = t.pendingSteps.some((s) => s.kind === "ask");
        const hasFreeText = hasTextStep(t.pendingSteps);
        if (!hasVerify && !hasAsk && !hasFreeText && t.pendingSteps.length > 0) {
          if (earlyGiveUp) {
            // Check early-give-up FIRST — loopsRun could coincidentally be at
            // MAX on the final iteration when the model also gave up, but the
            // give-up message is more informative for the user.
            exitNote = `**osheep code 提前结束本轮：** 模型这一轮只发出了 tasks / thought / 文本，既没有继续调用工具也没有给出 <verify> 或 <ask>。如果任务还没完成，请发送「继续」或下达更具体的指令。`;
          } else if (loopsRun >= MAX_TOOL_LOOPS) {
            exitNote = `**已达本轮工具调用上限 (${MAX_TOOL_LOOPS})。** osheep code 跑完 ${MAX_TOOL_LOOPS} 轮工具循环仍未给出 <verify>。继续请发送「继续」或下达更具体的下一步指令。`;
          } else {
            // Defensive catch-all: shouldn't normally happen.
            exitNote = `**本轮提前结束。** osheep code 跑了 ${loopsRun} 轮但没有 <verify>。请检查上方的步骤，再下达更具体的下一步指令。`;
          }
        }
      }

      if (exitNote) {
        commitSteps([...t.pendingSteps, { kind: "text", text: exitNote }]);
      }

      const finalText = collapseFinalText(t.pendingSteps);
      const finalSteps = t.pendingSteps;
      if (finalSteps.length === 0 && !finalText.trim() && !userAborted) {
        t.error = "CLI 未返回任何内容，请检查所选 CLI、模型名称或登录状态。";
        // Clear pending state BEFORE we hand control to React so the tab
        // never paints "pending steps + saved message" together.
        t.pendingSteps = [];
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
      const finalText = collapseFinalText(t.pendingSteps);
      if (t.pendingSteps.length > 0 || finalText.trim()) {
        const replyMsg: ChatMessage = {
          role: "assistant",
          content: finalText,
          timestamp: Date.now(),
          steps: [
            ...t.pendingSteps,
            {
              kind: "text",
              text: `**osheep code 因上游错误中断：** ${t.error}`,
            },
          ],
        };
        working = {
          ...working,
          messages: [...working.messages, replyMsg],
        };
      }
      try {
        const saved = await apiSaveSession(t.workspaceId, working);
        cb.setSession(saved);
        cb.onSessionChanged();
      } catch {
        /* ignore */
      }
    } finally {
      t.pendingSteps = [];
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
        t.status = "running";
        t.error = null;
        t.busy = true;
        this.notify(t);
        void this.runTurn(t, queued.provider, queued.model, queued.effort, queued.text);
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
    pendingConfirm: null,
    error: null,
  };
}

function buildCliTurnMessages(messages: ChatMessage[]): AiChatMessage[] {
  const out: AiChatMessage[] = [
    {
      role: "system",
      content: [
        "You are running as a local CLI coding agent inside the osheep IDE.",
        "Use your native CLI tools to inspect, edit, and verify the workspace directly.",
        "Do not emit osheep XML tags such as <tasks>, <thought>, or <tool>; those belong to the legacy API path.",
        "Reply in the user's language with a concise summary of what changed and any verification result.",
      ].join("\n"),
    },
  ];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "user",
        content: `Previous tool result:\n${message.content}`,
      });
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

function normalizeTasksItems(items: string[]): string[] {
  return items
    .map((it) => it.replace(/^\s+/, "").replace(/\s+$/, ""))
    .filter((it) => it.length > 0)
    .map((it) => {
      if (/^[-*+]\s+\[[ x~]\]/i.test(it)) return it;
      if (/^\[[ x~]\]/i.test(it)) return `- ${it}`;
      return `- [ ] ${it}`;
    });
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
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

interface ToolOutcome {
  status: "ok" | "err";
  result?: unknown;
  error?: string;
  toolResult: string;
}

interface CachedToolPayload {
  cached: true;
  tool: ToolKind;
  status: ToolOutcome["status"];
  message: string;
  previous: unknown;
  previousError?: string;
}

function makeCachedToolPayload(tool: ToolKind, outcome: ToolOutcome): CachedToolPayload {
  return {
    cached: true,
    tool,
    status: outcome.status,
    message:
      "Duplicate tool call skipped; this is the cached result from the identical call earlier in the same user turn.",
    previous: parseToolResult(outcome.toolResult),
    previousError: outcome.error,
  };
}

function stringifyCachedToolResult(payload: CachedToolPayload): string {
  return clipText(JSON.stringify(payload, null, 2) ?? "null", 128_000);
}

function parseToolResult(toolResult: string): unknown {
  try {
    return JSON.parse(toolResult);
  } catch {
    return toolResult;
  }
}

function validateToolCall(
  step: Extract<ChatStep, { kind: "tool" }>,
): { code: string; message: string } | null {
  const args = step.args;
  if (!isPlainRecord(args)) {
    return {
      code: "INVALID_TOOL_ARGS",
      message: `${step.tool} tool arguments must be a JSON object.`,
    };
  }
  if (typeof args._raw === "string") {
    return {
      code: "MALFORMED_TOOL_JSON",
      message:
        "Tool arguments were not valid JSON. Emit a valid JSON object inside the <tool> block.",
    };
  }

  if (step.tool === "read") return validateReadArgs(args);
  if (step.tool === "write") return validateWriteArgs(args);
  return validateRunArgs(args);
}

function validateReadArgs(args: Record<string, unknown>) {
  const kind = args.kind;
  if (kind !== "file" && kind !== "list" && kind !== "search") {
    return {
      code: "INVALID_READ_KIND",
      message: "read.kind must be one of file, list, or search.",
    };
  }
  if (kind === "file") {
    if (!isNonEmptyString(args.path)) {
      return { code: "MISSING_PATH", message: "read.file requires path." };
    }
    if (args.startLine !== undefined && !isPositiveInteger(args.startLine)) {
      return {
        code: "INVALID_START_LINE",
        message: "read.file startLine must be a positive integer.",
      };
    }
    if (args.lineCount !== undefined && !isPositiveInteger(args.lineCount)) {
      return {
        code: "INVALID_LINE_COUNT",
        message: "read.file lineCount must be a positive integer.",
      };
    }
  }
  if (kind === "list" && args.path !== undefined && typeof args.path !== "string") {
    return { code: "INVALID_PATH", message: "read.list path must be a string." };
  }
  if (kind === "search" && !isNonEmptyString(args.query)) {
    return { code: "MISSING_QUERY", message: "read.search requires query." };
  }
  return null;
}

function validateWriteArgs(args: Record<string, unknown>) {
  const kind = args.kind;
  if (
    kind !== "write_file" &&
    kind !== "append_file" &&
    kind !== "edit_file" &&
    kind !== "multi_edit" &&
    kind !== "move" &&
    kind !== "delete" &&
    kind !== "create"
  ) {
    return {
      code: "INVALID_WRITE_KIND",
      message:
        "write.kind must be one of write_file, append_file, edit_file, multi_edit, move, delete, or create.",
    };
  }

  if (kind === "write_file" || kind === "append_file") {
    if (!isNonEmptyString(args.path)) {
      return { code: "MISSING_PATH", message: `${kind} requires path.` };
    }
    if (typeof args.content !== "string") {
      return { code: "MISSING_CONTENT", message: `${kind} requires content.` };
    }
    return null;
  }

  if (kind === "edit_file") {
    if (!isNonEmptyString(args.path)) {
      return { code: "MISSING_PATH", message: "edit_file requires path." };
    }
    if (!isNonEmptyString(args.oldString)) {
      return {
        code: "MISSING_OLD_STRING",
        message: "edit_file requires a non-empty oldString.",
      };
    }
    if (typeof args.newString !== "string") {
      return { code: "MISSING_NEW_STRING", message: "edit_file requires newString." };
    }
    return null;
  }

  if (kind === "multi_edit") {
    if (!isNonEmptyString(args.path)) {
      return { code: "MISSING_PATH", message: "multi_edit requires path." };
    }
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return {
        code: "MISSING_EDITS",
        message: "multi_edit requires a non-empty edits array.",
      };
    }
    for (let i = 0; i < args.edits.length; i += 1) {
      const e = args.edits[i] as { oldString?: unknown; newString?: unknown };
      if (!e || typeof e !== "object") {
        return {
          code: "INVALID_EDIT_ITEM",
          message: `multi_edit edits[${i}] must be an object with oldString and newString.`,
        };
      }
      if (typeof e.oldString !== "string" || e.oldString.length === 0) {
        return {
          code: "MISSING_OLD_STRING",
          message: `multi_edit edits[${i}] requires a non-empty oldString.`,
        };
      }
      if (typeof e.newString !== "string") {
        return {
          code: "MISSING_NEW_STRING",
          message: `multi_edit edits[${i}] requires newString.`,
        };
      }
    }
    return null;
  }

  if (kind === "move") {
    if (!isNonEmptyString(args.from) || !isNonEmptyString(args.to)) {
      return { code: "MISSING_MOVE_PATH", message: "move requires from and to." };
    }
    return null;
  }

  if ((kind === "delete" || kind === "create") && !isNonEmptyString(args.path)) {
    return { code: "MISSING_PATH", message: `${kind} requires path.` };
  }
  if (
    kind === "create" &&
    args.entryKind !== undefined &&
    args.entryKind !== "file" &&
    args.entryKind !== "directory"
  ) {
    return {
      code: "INVALID_ENTRY_KIND",
      message: "create.entryKind must be file or directory.",
    };
  }
  return null;
}

function validateRunArgs(args: Record<string, unknown>) {
  if (!isNonEmptyString(args.command)) {
    return { code: "MISSING_COMMAND", message: "run requires command." };
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function invalidToolOutcome(tool: ToolKind, code: string, message: string): ToolOutcome {
  const payload = { ok: false, tool, code, status: 0, message };
  return {
    status: "err",
    result: payload,
    error: message,
    toolResult: stringifyToolError(tool, payload),
  };
}

async function executeToolCall(
  workspaceId: string,
  step: Extract<ChatStep, { kind: "tool" }>,
): Promise<ToolOutcome> {
  try {
    let resultPayload: unknown;
    if (step.tool === "read") {
      resultPayload = await execRead(workspaceId, step.args as ReadArgs);
    } else if (step.tool === "write") {
      resultPayload = await execWrite(workspaceId, step.args as WriteArgs);
    } else {
      resultPayload = await execRun(workspaceId, step.args as RunArgs);
    }

    if (step.tool === "run" && isRunTransportFailure(resultPayload)) {
      return {
        status: "err",
        result: resultPayload,
        error: "command did not complete",
        toolResult: stringifyToolResult(step.tool, resultPayload),
      };
    }

    return {
      status: "ok",
      result: resultPayload,
      toolResult: stringifyToolResult(step.tool, resultPayload),
    };
  } catch (e) {
    const payload = toolErrorPayload(e);
    return {
      status: "err",
      result: payload,
      error: payload.message,
      toolResult: stringifyToolError(step.tool, payload),
    };
  }
}

function isRunTransportFailure(result: unknown): boolean {
  const r = result as Partial<RunResult> | null;
  if (!r || typeof r !== "object") return false;
  return r.exitCode === null;
}

function toolErrorPayload(e: unknown): {
  ok: false;
  code: string;
  status: number;
  message: string;
} {
  if (e instanceof ApiClientError) {
    return {
      ok: false,
      code: e.code,
      status: e.status,
      message: e.message,
    };
  }
  return {
    ok: false,
    code: "CLIENT_ERROR",
    status: 0,
    message: (e as Error).message ?? String(e),
  };
}

function stringifyToolError(
  tool: ToolKind,
  payload: { code: string; status: number; message: string },
): string {
  return JSON.stringify(
    {
      ok: false,
      tool,
      code: payload.code,
      status: payload.status,
      message: payload.message,
    },
    null,
    2,
  );
}

function stringifyToolResult(t: ToolKind, result: unknown): string {
  if (t === "run") {
    const r = result as {
      command?: string;
      cwd?: string;
      shell?: string;
      attempts?: unknown[];
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      signal?: string | null;
      truncated?: boolean;
    };
    return JSON.stringify(
      {
        command: r.command ?? "",
        cwd: r.cwd ?? "",
        shell: r.shell ?? "",
        exitCode: r.exitCode ?? null,
        signal: r.signal ?? null,
        stdout: clipText(r.stdout ?? "", 16_000),
        stderr: clipText(r.stderr ?? "", 4_000),
        attempts: r.attempts ?? [],
        truncated: r.truncated ?? false,
      },
      null,
      2,
    );
  }
  if (t === "read") {
    const r = result as { kind?: string; content?: string } & Record<string, unknown>;
    if (r.kind === "file" && typeof r.content === "string") {
      const max = 96_000;
      const modelTruncated = r.content.length > max;
      return JSON.stringify(
        {
          ...r,
          content: clipText(r.content, max),
          modelTruncated,
        },
        null,
        2,
      );
    }
    return clipText(JSON.stringify(r, null, 2) ?? "null", 64_000);
  }
  if (t === "write") {
    // For edit_file the backend hands us a `diff.before`/`diff.after` pair
    // (full file contents) so the UI can render a Monaco diff tab. Sending
    // those back to the model would re-quote the whole file every turn — and
    // the model has already seen the file via the prior `read.file`. Strip
    // them out and keep only the line ranges + the small old/new snippets.
    // multi_edit has the same shape but with an `edits[]` array of per-edit
    // diffs; same logic applies — strip before/after, keep edits[] + totals.
    const r = result as Record<string, unknown> & {
      diff?: {
        oldString?: string;
        newString?: string;
        startLine?: number;
        endLineBefore?: number;
        endLineAfter?: number;
        added?: number;
        removed?: number;
        before?: string;
        after?: string;
        edits?: unknown;
      };
    };
    if (r?.diff && typeof r.diff === "object") {
      const { before: _b, after: _a, ...rest } = r.diff;
      const slimmed = { ...r, diff: rest };
      return clipText(JSON.stringify(slimmed, null, 2) ?? "null", 64_000);
    }
    return clipText(JSON.stringify(result, null, 2) ?? "null", 64_000);
  }
  return clipText(JSON.stringify(result, null, 2) ?? "null", 64_000);
}

function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function labelTool(t: ToolKind): string {
  if (t === "read") return "Read";
  if (t === "write") return "Edit/Write";
  return "Run";
}

function summarizeArgsForNote(t: ToolKind, args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  if (t === "run" && typeof a.command === "string") return `$ ${a.command}`;
  if (t === "read") {
    if (a.kind === "file" && typeof a.path === "string") return a.path;
    if (a.kind === "list" && typeof a.path === "string") return `list ${a.path}`;
    if (a.kind === "search" && typeof a.query === "string") return `search ${a.query}`;
  }
  if (t === "write") {
    const kind = typeof a.kind === "string" ? a.kind : "write";
    const p = typeof a.path === "string" ? a.path : ((a.to as string) ?? "");
    if (kind === "multi_edit" && Array.isArray(a.edits)) {
      return `${kind} ${p} (${a.edits.length} edits)`;
    }
    return `${kind} ${p}`;
  }
  return JSON.stringify(args);
}

function truncateForNote(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function buildRecentToolsReminder(
  executed: Array<{ tool: ToolKind; args: unknown; status: "ok" | "err" | "denied" | "cached" }>,
): string {
  // Show the most recent ~20 calls (older ones are already obvious from the
  // transcript); keep the line short enough that the model can skim it.
  const slice = executed.slice(-20);
  const lines = slice.map((e, i) => {
    const idx = executed.length - slice.length + i + 1;
    const sig = truncateForNote(summarizeArgsForNote(e.tool, e.args), 100);
    return `${idx}. ${labelTool(e.tool).toLowerCase()} ${sig} → ${e.status}`;
  });
  return [
    "<recent-tool-calls-this-turn>",
    ...lines,
    "</recent-tool-calls-this-turn>",
    "These calls have already been executed. Their results are in the transcript above. Do NOT re-emit any of them with identical arguments — pick a different next action or finish with <verify>.",
  ].join("\n");
}

function truncateAssistantRawAfterFirstTool(raw: string): string {
  const taggedEnd = firstTaggedToolEnd(raw);
  if (taggedEnd !== null) return raw.slice(0, taggedEnd);
  const bareEnd = firstBareToolEnd(raw);
  if (bareEnd !== null) return raw.slice(0, bareEnd);
  return raw;
}

function firstTaggedToolEnd(raw: string): number | null {
  const open = /<tool\b[^>]*\bname\s*=\s*["']?(read|write|run)["']?[^>]*>/i.exec(raw);
  if (!open || open.index === undefined) return null;
  const closeNeedle = "</tool>";
  const closeIdx = raw.toLowerCase().indexOf(closeNeedle, open.index + open[0].length);
  if (closeIdx < 0) return null;
  return closeIdx + closeNeedle.length;
}

function firstBareToolEnd(raw: string): number | null {
  const re = /(^|\n)[ \t]*(Read|Write|Run|read|write|run)\s*\r?\n\s*\{/g;
  const match = re.exec(raw);
  if (!match || match.index === undefined) return null;
  const braceOffset = match[0].lastIndexOf("{");
  if (braceOffset < 0) return null;
  const openIdx = match.index + braceOffset;
  const closeIdx = findMatchingJsonBrace(raw, openIdx);
  return closeIdx >= 0 ? closeIdx + 1 : null;
}

function findMatchingJsonBrace(s: string, openIdx: number): number {
  if (s[openIdx] !== "{") return -1;
  let depth = 0;
  let inStr = false;
  let escaping = false;
  for (let i = openIdx; i < s.length; i += 1) {
    const ch = s[i]!;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasTextStep(steps: ChatStep[]): boolean {
  return steps.some((s) => s.kind === "text" && s.text.trim().length > 0);
}

function collapseFinalText(steps: ChatStep[]): string {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i]!;
    if (s.kind === "verify") return s.text;
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i]!;
    if (s.kind === "text" && s.text.trim()) return s.text.trim();
  }
  return "";
}

// React hook — kept in this module to keep the runtime + binding together.
import { useSyncExternalStore } from "react";

export const chatRuntime = new ChatRuntime();

export function useChatTurn(sessionId: string): TurnView {
  return useSyncExternalStore(
    (cb) => chatRuntime.subscribe(sessionId, cb),
    () => chatRuntime.getView(sessionId),
    () => chatRuntime.getView(sessionId),
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
    getActiveSnapshot,
  );
  return new Set(ids);
}

// Helper re-export for callers that don't want a second import.
export { detectReasoningKind };
