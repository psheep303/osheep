import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import {
  getSession as apiGetSession,
  saveSession as apiSaveSession,
  type ChatMessage,
  type ChatStep,
  type EditFileDiff,
  type MultiEditDiff,
  type MultiEditEntry,
  type SessionRecord,
  type ToolKind,
} from "./api";
import { ChatMarkdown } from "./ChatMarkdown";
import { chatRuntime, useChatTurn } from "./chat-runtime";
import { buildUnifiedDiff, type DiffRowType } from "./file-diff";
import type { AiAutoAllow, OsheepSettings, ReasoningEffort } from "./settings";
import { DEFAULT_AUTO_ALLOW, DEFAULT_CLI_PROVIDER } from "./settings";

const SCROLL_STICKY_PX = 24;

interface ChatTabProps {
  workspaceId: string;
  sessionId: string;
  settings: OsheepSettings;
  onSettingsChange: (next: OsheepSettings) => void;
  onSessionChanged: () => void;
  /**
   * Fired after osheep code mutates the workspace (a successful `write` tool
   * of any kind, or any `run` command — shell commands may create/delete
   * files). The workbench uses this to refresh the file explorer and git
   * decorations without the user clicking "刷新".
   */
  onFilesChanged: () => void;
  onOpenSettings: () => void;
  /**
   * Open a Monaco diff Tab populated from an `edit_file` step's
   * `before`/`after` payload. Called when the user clicks "open full diff"
   * on a thumbnail diff rendered in a tool step.
   */
  onOpenAiDiff: (input: {
    sessionId: string;
    stepId: string;
    filePath: string;
    leftContent: string;
    rightContent: string;
  }) => void;
}

export function ChatTab({
  workspaceId,
  sessionId,
  settings,
  onSettingsChange,
  onSessionChanged,
  onFilesChanged,
  onOpenSettings,
  onOpenAiDiff,
}: ChatTabProps) {
  const { t } = useUiPreferences();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const view = useChatTurn(sessionId);
  const sending = view.status === "running" || view.status === "awaiting-confirm";

  const provider = DEFAULT_CLI_PROVIDER;
  const model = DEFAULT_CLI_PROVIDER.models[0] ?? "default";
  const effort: ReasoningEffort | null = null;

  const autoAllow: AiAutoAllow = settings.ai.autoAllow ?? DEFAULT_AUTO_ALLOW;

  const [slashOpen, setSlashOpen] = useState(false);
  const [autoAllowOpen, setAutoAllowOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Tracks whether the user is exactly at (or within a tiny epsilon of) the
  // bottom. New osheep-code state follows only in that case; arbitrary layout
  // resizes never pull the user away from history.
  const stickToBottomRef = useRef(true);

  // Load the session record on mount / session-switch.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    // Loading / switching sessions is not a "new runtime status" event; do
    // not force the scroll position. The scroll listener will mark pinned once
    // the user actually reaches the bottom.
    stickToBottomRef.current = false;
    apiGetSession(workspaceId, sessionId)
      .then((s) => {
        if (cancelled) return;
        setSession(s);
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sessionId]);

  // Wire callbacks into the runtime so the singleton can save sessions and
  // update settings even after this component unmounts.
  const sessionRef = useRef<SessionRecord | null>(null);
  sessionRef.current = session;
  const settingsRef = useRef<OsheepSettings>(settings);
  settingsRef.current = settings;
  const onSettingsChangeRef = useRef(onSettingsChange);
  onSettingsChangeRef.current = onSettingsChange;
  const onSessionChangedRef = useRef(onSessionChanged);
  onSessionChangedRef.current = onSessionChanged;
  const onFilesChangedRef = useRef(onFilesChanged);
  onFilesChangedRef.current = onFilesChanged;

  useEffect(() => {
    chatRuntime.setCallbacks(sessionId, {
      updateAutoAllow: (next) => {
        onSettingsChangeRef.current({
          ...settingsRef.current,
          ai: { ...settingsRef.current.ai, autoAllow: next },
        });
      },
      onSessionChanged: () => {
        onSessionChangedRef.current();
      },
      onFilesChanged: () => {
        onFilesChangedRef.current();
      },
      getSession: () => sessionRef.current,
      setSession: (next) => {
        sessionRef.current = next;
        setSession(next);
      },
      getAutoAllow: () => settingsRef.current.ai.autoAllow ?? DEFAULT_AUTO_ALLOW,
    });
  }, [sessionId]);

  // Auto-grow textarea.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 220);
    ta.style.height = `${next}px`;
  }, [input]);

  const scrollStateSignature = useMemo(
    () =>
      buildScrollStateSignature(
        session,
        view.status,
        view.pendingConfirm?.call.id,
        view.pendingSteps,
      ),
    [session, view.status, view.pendingConfirm, view.pendingSteps],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
      const first = window.requestAnimationFrame(() => {
        if (!stickToBottomRef.current || !scrollRef.current) return;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        window.requestAnimationFrame(() => {
          if (!stickToBottomRef.current || !scrollRef.current) return;
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      });
      return () => window.cancelAnimationFrame(first);
    } else {
      stickToBottomRef.current = isAtScrollBottom(el);
    }
  }, [scrollStateSignature]);

  // Update the "is near bottom" tracker as the user scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottomRef.current = isAtScrollBottom(el);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const readyToSend = true;

  const sendBlockReason = "";

  const stopStream = () => {
    chatRuntime.stop(sessionId);
  };

  const updateAutoAllow = (next: AiAutoAllow) => {
    onSettingsChange({
      ...settings,
      ai: { ...settings.ai, autoAllow: next },
    });
  };

  const clearConversation = async () => {
    if (!session) return;
    if (!window.confirm(t("chat.clearConfirm"))) return;
    const next: SessionRecord = {
      ...session,
      messages: [],
      providerId: provider.id,
      model,
    };
    try {
      const saved = await apiSaveSession(workspaceId, next);
      setSession(saved);
      onSessionChanged();
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  const sendMessage = (rawText: string) => {
    if (!session) return;
    const text = rawText.trim();
    if (!text) return;
    if (!readyToSend) return;

    // chatRuntime.send handles the "queue on top of a running turn" case
    // internally — it aborts the current upstream stream, resolves any
    // pending tool-confirm as deny, and reruns with the new payload once
    // the previous loop unwinds.
    setInput("");
    chatRuntime.send({
      workspaceId,
      provider,
      model,
      effort: effort && effort !== "off" ? effort : null,
      text,
      callbacks: {
        updateAutoAllow: (next) =>
          onSettingsChange({
            ...settings,
            ai: { ...settings.ai, autoAllow: next },
          }),
        onSessionChanged,
        onFilesChanged,
        getSession: () => sessionRef.current,
        setSession: (s) => {
          sessionRef.current = s;
          setSession(s);
        },
        getAutoAllow: () => settingsRef.current.ai.autoAllow ?? DEFAULT_AUTO_ALLOW,
      },
    });
  };

  const handleSend = () => sendMessage(input);

  const handleAskAnswer = async (answer: string) => {
    if (!session) return;
    const last = session.messages[session.messages.length - 1];
    if (last?.role !== "assistant") return;
    const steps = last.steps ?? [];
    const lastStep = steps[steps.length - 1];
    if (lastStep?.kind !== "ask") return;

    // Update the ask step with the answer
    const updatedSteps = steps.map((s, i) =>
      i === steps.length - 1 && s.kind === "ask" ? { ...s, answer } : s,
    );
    const updatedMessage = { ...last, steps: updatedSteps };
    const updatedMessages = [...session.messages.slice(0, -1), updatedMessage];
    const updatedSession = { ...session, messages: updatedMessages };

    try {
      await apiSaveSession(workspaceId, updatedSession);
      setSession(updatedSession);
      // Now send the answer as a new user message to continue the conversation
      sendMessage(answer);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  const pendingAsk = useMemo(() => {
    if (!session || sending) return null;
    const last = session.messages[session.messages.length - 1];
    if (last?.role !== "assistant") return null;
    const steps = last.steps ?? [];
    const lastStep = steps[steps.length - 1];
    if (lastStep?.kind === "ask" && !lastStep.answer) return lastStep;
    return null;
  }, [session, sending]);

  if (loading) return <div className="empty-hint">{t("chat.loading")}</div>;
  if (!session) return <div className="empty-hint">{loadError ?? t("chat.loadFailed")}</div>;

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Send is permitted whenever there's text and a model is ready — even
      // mid-task. handleSend() stops the running turn first and starts a
      // new round with the new prompt.
      if (readyToSend && input.trim()) handleSend();
    } else if (e.key === "Escape" && sending) {
      e.preventDefault();
      stopStream();
    } else if (e.key === "/" && input === "") {
      setSlashOpen(true);
    }
  };

  return (
    <div className="chat-tab">
      <div className="chat-tab__messages" ref={scrollRef}>
        <div className="chat-tab__messages-inner">
          {session.messages.length === 0 && !sending && (
            <div className="chat-tab__welcome">
              <div className="chat-tab__welcome-title">{session.title || t("chat.new")}</div>
              <div className="chat-tab__welcome-hint">
                {readyToSend ? t("chat.prompt") : sendBlockReason}
              </div>
            </div>
          )}
          {session.messages.map((m, i) => (
            <MessageBlock key={i} message={m} sessionId={sessionId} onOpenAiDiff={onOpenAiDiff} />
          ))}
          {sending && (
            <PendingAssistant
              steps={view.pendingSteps}
              status={view.status}
              sessionId={sessionId}
              onOpenAiDiff={onOpenAiDiff}
            />
          )}
        </div>
      </div>

      {(view.error || loadError) && (
        <div className="chat-tab__error">
          <span className="chat-tab__error-msg">{view.error || loadError}</span>
          <button
            className="chat-tab__error-close"
            onClick={() => {
              chatRuntime.clearError(sessionId);
              setLoadError(null);
            }}
            aria-label={t("chat.closeError")}
          >
            ×
          </button>
        </div>
      )}

      {view.pendingConfirm ? (
        <ToolConfirmBar
          call={view.pendingConfirm.call}
          categoryLabel={view.pendingConfirm.category.label}
          onAllow={() => chatRuntime.resolveConfirm(sessionId, "allow")}
          onDeny={() => chatRuntime.resolveConfirm(sessionId, "deny")}
          onFeedback={(text) => chatRuntime.resolveConfirm(sessionId, { kind: "feedback", text })}
        />
      ) : null}

      {pendingAsk && (
        <AskPromptDialog ask={pendingAsk} disabled={!readyToSend} onAnswer={handleAskAnswer} />
      )}

      {autoAllowOpen && (
        <AutoAllowPanel
          value={autoAllow}
          onChange={updateAutoAllow}
          onClose={() => setAutoAllowOpen(false)}
        />
      )}

      <div className="chat-tab__composer-wrap">
        <div
          className={`chat-composer${sending ? " is-busy" : ""}${!readyToSend ? " is-blocked" : ""}`}
        >
          <textarea
            ref={textareaRef}
            className="chat-composer__input"
            value={input}
            rows={1}
            placeholder={
              readyToSend
                ? `${t("chat.promptPlaceholder")}  ( /  ${t("chat.openSlashMenu")} )`
                : sendBlockReason || t("chat.promptPlaceholder")
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="chat-composer__row">
            <div className="chat-composer__row-left">
              <button
                className="chat-composer__icon-btn"
                title={t("chat.attachSoon")}
                disabled
                tabIndex={-1}
              >
                <PlusIcon />
              </button>
              <button
                className="chat-composer__icon-btn"
                title={t("chat.openSlashMenu")}
                onClick={() => {
                  setSlashOpen((v) => !v);
                }}
              >
                <SlashIcon />
              </button>
              {slashOpen && (
                <SlashMenu
                  onClose={() => setSlashOpen(false)}
                  onClear={() => {
                    setSlashOpen(false);
                    void clearConversation();
                  }}
                  onOpenSettings={() => {
                    setSlashOpen(false);
                    onOpenSettings();
                  }}
                  onAutoAllow={() => {
                    setSlashOpen(false);
                    setAutoAllowOpen(true);
                  }}
                />
              )}
            </div>
            <div className="chat-composer__row-right">
              {sending && !input.trim() ? (
                <button
                  className="chat-composer__send is-stop"
                  onClick={stopStream}
                  title={t("chat.stop")}
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  className="chat-composer__send"
                  disabled={!readyToSend || !input.trim()}
                  onClick={() => handleSend()}
                  title={
                    !readyToSend
                      ? sendBlockReason
                      : !input.trim()
                        ? t("chat.enterContent")
                        : sending
                          ? t("chat.stopAndSend")
                          : t("chat.send")
                  }
                >
                  <ArrowUpIcon />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────── Sub-components ─────────────────

type OpenAiDiff = ChatTabProps["onOpenAiDiff"];

function MessageBlock({
  message,
  sessionId,
  onOpenAiDiff,
}: {
  message: ChatMessage;
  sessionId: string;
  onOpenAiDiff: OpenAiDiff;
}) {
  if (message.role === "tool") {
    return null;
  }
  if (message.role === "user") {
    return (
      <div className="chat-msg chat-msg--user">
        <div className="chat-msg__chip">
          <span className="chat-msg__chip-dot chat-msg__chip-dot--user" />你
        </div>
        <div className="chat-msg__content">
          <ChatMarkdown source={message.content} />
        </div>
      </div>
    );
  }
  const steps = message.steps ?? [];
  // Check if content is already in a text step to avoid duplication
  // Use strict comparison with trimmed content
  const hasTextStep = steps.some(
    (s) =>
      s.kind === "text" && s.text && message.content && s.text.trim() === message.content.trim(),
  );
  // Also check if the content is empty or whitespace-only
  const hasContent = message.content && message.content.trim().length > 0;
  return (
    <div className="chat-msg chat-msg--assistant">
      <div className="chat-msg__chip">
        <span className="chat-msg__chip-dot chat-msg__chip-dot--assistant" />
        osheep code
      </div>
      <div className="chat-msg__timeline">
        {steps.map((s, i) => (
          <StepRow
            key={i}
            step={s}
            streaming={false}
            sessionId={sessionId}
            onOpenAiDiff={onOpenAiDiff}
          />
        ))}
        {hasContent && !hasTextStep && (
          <div className="chat-step chat-step--text">
            <span className="chat-step__icon chat-step__icon--text" />
            <div className="chat-step__body">
              <ChatMarkdown source={message.content} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function isAtScrollBottom(el: HTMLElement): boolean {
  const slack = el.scrollHeight - el.scrollTop - el.clientHeight;
  return slack <= SCROLL_STICKY_PX;
}

function buildScrollStateSignature(
  session: SessionRecord | null,
  status: string,
  confirmId: string | undefined,
  pendingSteps: ChatStep[],
): string {
  const last = session?.messages[session.messages.length - 1];
  const lastStep = last?.steps?.[last.steps.length - 1];
  return [
    session?.id ?? "",
    session?.messages.length ?? 0,
    last?.role ?? "",
    last?.timestamp ?? 0,
    last?.content.length ?? 0,
    last?.steps?.length ?? 0,
    lastStep ? stepSignature(lastStep) : "",
    status,
    confirmId ?? "",
    pendingSteps.map(stepSignature).join("|"),
  ].join("::");
}

function stepSignature(step: ChatStep): string {
  if (step.kind === "plan") return `plan:${step.items.join("\n")}`;
  if (step.kind === "thought") {
    return `thought:${step.id}:${step.text.length}:${step.endedAt ?? ""}`;
  }
  if (step.kind === "tool") {
    return ["tool", step.id, step.status, step.error ?? "", valueSignature(step.result)].join(":");
  }
  if (step.kind === "ask") {
    return `ask:${step.id ?? ""}:${step.question}:${step.options.join("\n")}`;
  }
  if (step.kind === "verify") return `verify:${step.text.length}:${step.text.slice(-32)}`;
  return `text:${step.text.length}:${step.text.slice(-32)}`;
}

function valueSignature(value: unknown): string {
  if (value === undefined) return "";
  try {
    const json = JSON.stringify(value);
    return `${json.length}:${json.slice(0, 128)}:${json.slice(-128)}`;
  } catch {
    return String(value);
  }
}

function PendingAssistant({
  steps,
  status,
  sessionId,
  onOpenAiDiff,
}: {
  steps: ChatStep[];
  status: string;
  sessionId: string;
  onOpenAiDiff: OpenAiDiff;
}) {
  return (
    <div className="chat-msg chat-msg--assistant is-pending">
      <div className="chat-msg__chip">
        <span className="chat-msg__chip-dot chat-msg__chip-dot--assistant" />
        osheep code
        <span className="chat-msg__typing-pill">
          {status === "awaiting-confirm" ? "waiting" : "thinking"}
        </span>
      </div>
      <div className="chat-msg__timeline">
        {steps.map((s, i) => (
          <StepRow
            key={i}
            step={s}
            streaming={isStreamingStep(s, status, i === steps.length - 1)}
            sessionId={sessionId}
            onOpenAiDiff={onOpenAiDiff}
          />
        ))}
        {steps.length === 0 ? (
          <div className="chat-step chat-step--text is-streaming">
            <span className="chat-step__icon chat-step__icon--text" />
            <div className="chat-step__body">
              <SheepCoding />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function isStreamingStep(step: ChatStep, status: string, isLast: boolean): boolean {
  if (status === "awaiting-confirm") return false;
  if (step.kind === "thought") return step.endedAt === undefined;
  if (step.kind === "tool") return step.status === "running";
  if (step.kind === "text") return isLast && status === "running";
  return false;
}

function SheepCoding() {
  return (
    <span className="sheep-coding" aria-hidden>
      <span className="sheep-coding__track">
        <span className="sheep-coding__sheep">Ꮚ</span>
        <span className="sheep-coding__dust sheep-coding__dust--one" />
        <span className="sheep-coding__dust sheep-coding__dust--two" />
      </span>
      <span className="sheep-coding__text">coding...</span>
    </span>
  );
}

function formatThoughtDuration(step: Extract<ChatStep, { kind: "thought" }>): string {
  if (typeof step.startedAt !== "number") return "";
  const end = typeof step.endedAt === "number" ? step.endedAt : Date.now();
  const seconds = Math.max(0, Math.round((end - step.startedAt) / 1000));
  return `for ${seconds}s`;
}

function StepRow({
  step,
  streaming,
  sessionId,
  onOpenAiDiff,
}: {
  step: ChatStep;
  streaming: boolean;
  sessionId: string;
  onOpenAiDiff: OpenAiDiff;
}) {
  if (step.kind === "plan") {
    // Each plan item should be a complete markdown checkbox line. The
    // parser now preserves the `- [ ]` / `- [~]` / `- [x]` prefix verbatim,
    // so we only normalise legacy entries that arrive as bare text. We must
    // NOT prepend `- [ ]` to an item that already starts with `[ ]` —
    // doing so creates `- [ ] [ ] task`, which marked renders as a real
    // checkbox followed by a literal `[ ]` glyph.
    const md = step.items
      .map((it) => {
        const trimmed = it.replace(/^\s+/, "").replace(/\s+$/, "");
        if (/^[-*+]\s+\[[ x~]\]/i.test(trimmed)) return trimmed;
        // Item already in `[ ] foo` form (legacy parser output) — re-attach
        // the bullet so marked picks it up.
        if (/^\[[ x~]\]/i.test(trimmed)) return `- ${trimmed}`;
        // Bare line — assume "not done".
        return `- [ ] ${trimmed}`;
      })
      .join("\n");
    return (
      <div className={`chat-step chat-step--plan${streaming ? " is-streaming" : ""}`}>
        <span className="chat-step__icon chat-step__icon--plan" />
        <div className="chat-step__body">
          <div className="chat-step__label">Tasks</div>
          {streaming && <SheepCoding />}
          <ChatMarkdown source={md} compact />
        </div>
      </div>
    );
  }
  if (step.kind === "ask") {
    // Don't render ask steps in the timeline if they haven't been answered yet
    // (the AskPromptDialog will handle the UI for pending asks)
    if (!step.answer && !streaming) {
      return null;
    }
    return (
      <div className={`chat-step chat-step--ask${streaming ? " is-streaming" : ""}`}>
        <span className="chat-step__icon chat-step__icon--ask" />
        <div className="chat-step__body">
          <span className="chat-step__label">Ask</span>
          {streaming && <SheepCoding />}
          {step.answer ? (
            <div className="ask-step__io">
              <div className="ask-step__in">
                <span className="ask-step__io-label">in</span>
                <span className="ask-step__question">{step.question}</span>
              </div>
              <div className="ask-step__out">
                <span className="ask-step__io-label">out</span>
                <span className="ask-step__answer">{step.answer}</span>
              </div>
            </div>
          ) : (
            <>
              <div className="ask-step__question">{step.question}</div>
              <div className="ask-step__options">
                {step.options.map((option, idx) => (
                  <span key={idx} className="ask-step__option">
                    {String.fromCharCode(65 + idx)}. {option}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
  if (step.kind === "thought") {
    return (
      <div className={`chat-step chat-step--thought${streaming ? " is-streaming" : ""}`}>
        <span className="chat-step__icon chat-step__icon--thought" />
        <div className="chat-step__body">
          <span className="chat-step__label">Thought</span>
          <span className="chat-step__duration">{formatThoughtDuration(step)}</span>
          {streaming && <SheepCoding />}
          <ChatMarkdown source={step.text || "正在思考下一步…"} compact />
        </div>
      </div>
    );
  }
  if (step.kind === "verify") {
    return (
      <div className={`chat-step chat-step--verify${streaming ? " is-streaming" : ""}`}>
        <span className="chat-step__icon chat-step__icon--verify">
          <CheckIcon />
        </span>
        <div className="chat-step__body">
          <span className="chat-step__label">Verify</span>
          {streaming && <SheepCoding />}
          <ChatMarkdown source={step.text} compact />
        </div>
      </div>
    );
  }
  if (step.kind === "text") {
    return (
      <div className={`chat-step chat-step--text${streaming ? " is-streaming" : ""}`}>
        <span className="chat-step__icon chat-step__icon--text" />
        <div className="chat-step__body">
          <ChatMarkdown source={step.text} compact />
        </div>
      </div>
    );
  }
  const iconClass =
    step.status === "ok"
      ? "chat-step__icon--ok"
      : step.status === "err"
        ? "chat-step__icon--err"
        : step.status === "denied"
          ? "chat-step__icon--err"
          : step.status === "cached"
            ? "chat-step__icon--cached"
            : step.status === "queued"
              ? "chat-step__icon--queued"
              : "chat-step__icon--running";
  return (
    <ToolStepRow
      step={step}
      iconClass={iconClass}
      streaming={streaming}
      sessionId={sessionId}
      onOpenAiDiff={onOpenAiDiff}
    />
  );
}

function ToolStepRow({
  step,
  iconClass,
  streaming,
  sessionId,
  onOpenAiDiff,
}: {
  step: Extract<ChatStep, { kind: "tool" }>;
  iconClass: string;
  streaming: boolean;
  sessionId: string;
  onOpenAiDiff: OpenAiDiff;
}) {
  // edit_file / multi_edit render as ONE whole-file thumbnail diff (computed
  // from the backend's before/after), mirroring how Claude Code shows a file
  // change — not a stack of per-edit snippets. `run` renders an in/out card
  // (command + stdout/stderr). Both default to showing inline; read / search /
  // list keep the click-to-expand raw output.
  const isDone = step.status === "ok" || step.status === "cached";
  const fileDiff = isDone ? extractFileDiff(step) : null;
  const runIo =
    step.tool === "run" && (isDone || step.status === "err") ? extractRunIo(step) : null;
  // While a write/run is queued or mid-execution we have no backend result
  // yet — preview the proposed change/command from the model's tool args so
  // the user sees it inline (not only in the approval bar).
  const isPending = step.status === "queued" || step.status === "running";
  const editPreview =
    isPending && step.tool === "write" && !fileDiff ? extractEditConfirmPreview(step.args) : null;
  const multiEditPreview =
    isPending && step.tool === "write" && !fileDiff && !editPreview
      ? extractMultiEditConfirmPreview(step.args)
      : null;
  // write_file / append_file have no diff (whole-file write), so we preview
  // the written content both before AND after the call lands.
  const writePreview =
    step.tool === "write" && !fileDiff && !editPreview && !multiEditPreview
      ? extractWriteContentPreview(step.args)
      : null;
  const runPreview = isPending && step.tool === "run" ? extractRunPreview(step.args) : null;
  const [expanded, setExpanded] = useState(false);
  const [diffCollapsed, setDiffCollapsed] = useState(false);
  const label = labelForTool(step.tool, step.args);
  const summaryBase = summarizeTool(step.tool, step.args);
  const summary = step.status === "cached" ? `${summaryBase} (cached)` : summaryBase;
  const lineMeta = toolLineMeta(step, fileDiff);
  const resultText = step.result
    ? prettyToolResult(step.tool, step.result)
    : step.error
      ? step.error
      : "";
  const openFullDiff = () => {
    if (!fileDiff) return;
    onOpenAiDiff({
      sessionId,
      stepId: step.id,
      filePath: extractEditPath(step.args) ?? "(unknown)",
      leftContent: fileDiff.before,
      rightContent: fileDiff.after,
    });
  };
  const hasInlineCard =
    !!fileDiff || !!editPreview || !!multiEditPreview || !!writePreview || !!runIo || !!runPreview;
  return (
    <div className={`chat-step chat-step--tool${streaming ? " is-streaming" : ""}`}>
      <span className={`chat-step__icon ${iconClass}`}>
        {step.status === "ok" && <CheckIcon />}
        {(step.status === "err" || step.status === "denied") && <CrossIcon />}
        {step.status === "cached" && <CachedIcon />}
        {(step.status === "queued" || step.status === "running") && (
          <span className="chat-step__icon-dot" aria-hidden />
        )}
      </span>
      <div className="chat-step__body">
        <button
          className="chat-step__tool-head"
          onClick={() => {
            // With an inline card (diff / run-io / preview) the head click
            // toggles the card; otherwise it toggles the raw-output <pre>.
            if (hasInlineCard) setDiffCollapsed((v) => !v);
            else setExpanded((v) => !v);
          }}
        >
          <span className="chat-step__label">{label}</span>
          {streaming && <SheepCoding />}
          <span className="chat-step__inline">{summary}</span>
          {lineMeta && <span className="chat-step__line-meta">{lineMeta}</span>}
          {fileDiff && (
            <span className="chat-step__diff-summary">
              +{fileDiff.added} / -{fileDiff.removed}
            </span>
          )}
          {runIo && (
            <span
              className={
                "chat-step__diff-summary chat-step__exit" +
                (runIo.errorMessage || (runIo.exitCode ?? 1) !== 0 ? " chat-step__exit--bad" : "")
              }
            >
              {runIo.errorMessage ? "失败" : `exit ${runIo.exitCode ?? "?"}`}
            </span>
          )}
          {(editPreview || multiEditPreview || writePreview || runPreview) &&
            !fileDiff &&
            !runIo && (
              <span className="chat-step__diff-summary chat-step__diff-summary--pending">
                {step.status === "queued"
                  ? "排队中"
                  : step.status === "running"
                    ? "处理中"
                    : isDone
                      ? "已写入"
                      : "预览"}
              </span>
            )}
        </button>
        {fileDiff && !diffCollapsed && (
          <FileDiffThumbnail
            diff={fileDiff}
            filePath={extractEditPath(step.args) ?? "(unknown)"}
            onOpenFull={openFullDiff}
            onCollapse={() => setDiffCollapsed(true)}
          />
        )}
        {runIo && !diffCollapsed && (
          <RunIoCard io={runIo} onCollapse={() => setDiffCollapsed(true)} />
        )}
        {runPreview && !runIo && !diffCollapsed && (
          <RunPreviewCard
            preview={runPreview}
            status={step.status}
            onCollapse={() => setDiffCollapsed(true)}
          />
        )}
        {editPreview && !fileDiff && !diffCollapsed && (
          <EditPreviewCard preview={editPreview} onCollapse={() => setDiffCollapsed(true)} />
        )}
        {multiEditPreview && !fileDiff && !editPreview && !diffCollapsed && (
          <MultiEditPreviewCard
            preview={multiEditPreview}
            onCollapse={() => setDiffCollapsed(true)}
          />
        )}
        {writePreview && !fileDiff && !editPreview && !multiEditPreview && !diffCollapsed && (
          <WritePreviewCard
            preview={writePreview}
            done={isDone}
            onCollapse={() => setDiffCollapsed(true)}
          />
        )}
        {expanded && !hasInlineCard && resultText && (
          <pre className="chat-step__tool-output">{resultText}</pre>
        )}
      </div>
    </div>
  );
}

/**
 * Whole-file thumbnail diff for a completed `edit_file` / `multi_edit`. Mirrors
 * how Claude Code shows a file change in its terminal: one card per file with a
 * single unified diff (real line numbers, a few lines of context, long
 * unchanged runs collapsed to `⋯`). The exact, full diff opens in a Monaco tab
 * via "完整 diff →". Computed entirely from the backend's `before` / `after`.
 */
function FileDiffThumbnail({
  diff,
  filePath,
  onOpenFull,
  onCollapse,
}: {
  diff: FileDiff;
  filePath: string;
  onOpenFull: () => void;
  onCollapse?: () => void;
}) {
  const unified = useMemo(
    () => buildUnifiedDiff(diff.before, diff.after, { context: 3, maxRows: 60 }),
    [diff.before, diff.after],
  );
  const meta =
    diff.kind === "multi_edit"
      ? `${diff.editsCount} edits`
      : typeof diff.startLine === "number"
        ? `:${diff.startLine}`
        : "";
  return (
    <div className="edit-diff">
      <div className="edit-diff__head">
        <span className="edit-diff__path">
          {filePath}
          {meta && <span className="edit-diff__line"> {meta}</span>}
          <span className="edit-diff__line">
            {" "}
            +{diff.added} / -{diff.removed}
          </span>
        </span>
        <div className="edit-diff__head-actions">
          <button
            className="edit-diff__open"
            onClick={(e) => {
              e.stopPropagation();
              onOpenFull();
            }}
            title="在新标签页打开完整 diff"
          >
            完整 diff →
          </button>
          {onCollapse && (
            <button
              className="edit-diff__collapse"
              onClick={(e) => {
                e.stopPropagation();
                onCollapse();
              }}
              title="折叠 diff（仍可点击工具行重新展开）"
              aria-label="折叠 diff"
            >
              ▾
            </button>
          )}
        </div>
      </div>
      <div className="edit-diff__body">
        {unified.rows.map((row, i) => (
          <div key={i} className={`edit-diff__row ${diffRowClass(row.type)}`}>
            <span className="edit-diff__num">{row.type === "gap" ? "" : row.num}</span>
            <span className="edit-diff__sign">
              {row.type === "add" ? "+" : row.type === "del" ? "-" : ""}
            </span>
            <span className="edit-diff__text">
              {row.type === "gap" ? row.text : row.text || " "}
            </span>
          </div>
        ))}
        {unified.truncated && (
          <div className="edit-diff__row edit-diff__row--ellipsis">
            <span className="edit-diff__num" />
            <span className="edit-diff__sign" />
            <span className="edit-diff__text">… diff 较大已截断，点「完整 diff →」查看全部</span>
          </div>
        )}
      </div>
    </div>
  );
}

function diffRowClass(t: DiffRowType): string {
  if (t === "add") return "edit-diff__row--add";
  if (t === "del") return "edit-diff__row--del";
  if (t === "gap") return "edit-diff__row--ellipsis";
  return "edit-diff__row--ctx";
}

/**
 * In/out card for a completed `run` step — the terminal-command analogue of
 * the diff card. Head shows the command (in) + exit badge + duration; body
 * shows stdout/stderr (out), capped and scrollable. Click the tool head to
 * collapse it.
 */
function RunIoCard({ io, onCollapse }: { io: RunIo; onCollapse?: () => void }) {
  const MAX_LINES = 200;
  const outLines = io.stdout.replace(/\n$/, "") ? io.stdout.replace(/\n$/, "").split("\n") : [];
  const errLines = io.stderr.replace(/\n$/, "") ? io.stderr.replace(/\n$/, "").split("\n") : [];
  const shownOut = outLines.slice(0, MAX_LINES);
  const shownErr = errLines.slice(0, Math.max(0, MAX_LINES - shownOut.length));
  const outClipped = outLines.length - shownOut.length;
  const errClipped = errLines.length - shownErr.length;
  const bad = !!io.errorMessage || (io.exitCode ?? 1) !== 0;
  const dur = typeof io.durationMs === "number" ? formatDuration(io.durationMs) : "";
  const empty = !io.errorMessage && outLines.length === 0 && errLines.length === 0;
  return (
    <div className="run-io">
      <div className="run-io__head">
        <span className="run-io__prompt" aria-hidden>
          $
        </span>
        <span className="run-io__cmd">{io.command || "(command)"}</span>
        <div className="run-io__head-actions">
          {dur && <span className="run-io__dur">{dur}</span>}
          <span className={`run-io__exit${bad ? " run-io__exit--bad" : ""}`}>
            {io.errorMessage ? "失败" : `exit ${io.exitCode ?? "?"}`}
          </span>
          {onCollapse && (
            <button
              className="edit-diff__collapse"
              onClick={(e) => {
                e.stopPropagation();
                onCollapse();
              }}
              title="折叠输出（仍可点击工具行重新展开）"
              aria-label="折叠输出"
            >
              ▾
            </button>
          )}
        </div>
      </div>
      <div className="run-io__body">
        {io.cwd && <div className="run-io__meta">cwd: {io.cwd}</div>}
        {io.errorMessage && <div className="run-io__line run-io__line--err">{io.errorMessage}</div>}
        {shownOut.map((ln, i) => (
          <div key={`o${i}`} className="run-io__line">
            {ln || " "}
          </div>
        ))}
        {outClipped > 0 && (
          <div className="run-io__line run-io__more">… 还有 {outClipped} 行 stdout</div>
        )}
        {shownErr.length > 0 && <div className="run-io__stream-label">stderr</div>}
        {shownErr.map((ln, i) => (
          <div key={`e${i}`} className="run-io__line run-io__line--err">
            {ln || " "}
          </div>
        ))}
        {errClipped > 0 && (
          <div className="run-io__line run-io__more">… 还有 {errClipped} 行 stderr</div>
        )}
        {empty && <div className="run-io__line run-io__more">（无输出）</div>}
      </div>
    </div>
  );
}

/** Pre-execution preview for a `run` step — just the command (in), no output yet. */
function RunPreviewCard({
  preview,
  status,
  onCollapse,
}: {
  preview: { command: string; cwd?: string };
  status: string;
  onCollapse?: () => void;
}) {
  return (
    <div className="run-io run-io--pending">
      <div className="run-io__head">
        <span className="run-io__prompt" aria-hidden>
          $
        </span>
        <span className="run-io__cmd">{preview.command}</span>
        <div className="run-io__head-actions">
          <span className="run-io__exit run-io__exit--pending">
            {status === "running" ? "运行中…" : "待执行"}
          </span>
          {onCollapse && (
            <button
              className="edit-diff__collapse"
              onClick={(e) => {
                e.stopPropagation();
                onCollapse();
              }}
              title="折叠"
              aria-label="折叠"
            >
              ▾
            </button>
          )}
        </div>
      </div>
      {preview.cwd && (
        <div className="run-io__body">
          <div className="run-io__meta">cwd: {preview.cwd}</div>
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/**
 * Inline pre-approval / pre-execution diff card. Mirrors the visual style of
 * EditDiffThumbnail but uses oldString / newString from the model's tool
 * args (no backend response yet, so no startLine / before / after).
 */
function EditPreviewCard({
  preview,
  onCollapse,
}: {
  preview: EditConfirmPreviewData;
  onCollapse?: () => void;
}) {
  const oldLines = preview.oldString.replace(/\n$/, "").split("\n");
  const newLines = preview.newString.replace(/\n$/, "").split("\n");
  const MAX = 14;
  const showOld = oldLines.slice(0, MAX);
  const showNew = newLines.slice(0, MAX);
  const oldClipped = oldLines.length - showOld.length;
  const newClipped = newLines.length - showNew.length;
  return (
    <div className="edit-diff edit-diff--pending">
      <div className="edit-diff__head">
        <span className="edit-diff__path">
          {preview.path}
          <span className="edit-diff__hint">即将修改（等待审批/执行）</span>
        </span>
        {onCollapse && (
          <div className="edit-diff__head-actions">
            <button
              className="edit-diff__collapse"
              onClick={(e) => {
                e.stopPropagation();
                onCollapse();
              }}
              title="折叠预览"
              aria-label="折叠预览"
            >
              ▾
            </button>
          </div>
        )}
      </div>
      <div className="edit-diff__body">
        {showOld.map((ln, i) => (
          <div key={`o${i}`} className="edit-diff__row edit-diff__row--del">
            <span className="edit-diff__sign">-</span>
            <span className="edit-diff__text">{ln}</span>
          </div>
        ))}
        {oldClipped > 0 && (
          <div className="edit-diff__row edit-diff__row--ellipsis">
            <span className="edit-diff__sign" />
            <span className="edit-diff__text">… (-{oldClipped} 行未显示)</span>
          </div>
        )}
        {showNew.map((ln, i) => (
          <div key={`n${i}`} className="edit-diff__row edit-diff__row--add">
            <span className="edit-diff__sign">+</span>
            <span className="edit-diff__text">{ln}</span>
          </div>
        ))}
        {newClipped > 0 && (
          <div className="edit-diff__row edit-diff__row--ellipsis">
            <span className="edit-diff__sign" />
            <span className="edit-diff__text">… (+{newClipped} 行未显示)</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Combined diff card for a `multi_edit` step: one path header, then a stack
 * of mini -/+ blocks (one per edit in the batch). The "完整 diff →" button
 * opens a single Monaco DiffEditor covering before → after of the whole file
 * after all edits applied, mirroring how Claude Code's MultiEdit summary works.
 */
/**
 * Pre-approval / pre-execution card for `multi_edit`. No `startLine` /
 * `added` / `removed` are known yet — only the raw `oldString` / `newString`
 * pairs from the model's tool args.
 */
function MultiEditPreviewCard({
  preview,
  onCollapse,
}: {
  preview: { path: string; edits: Array<{ oldString: string; newString: string }> };
  onCollapse?: () => void;
}) {
  return (
    <div className="edit-diff edit-diff--pending">
      <div className="edit-diff__head">
        <span className="edit-diff__path">
          {preview.path}
          <span className="edit-diff__hint">
            即将修改 {preview.edits.length} 处（等待审批/执行）
          </span>
        </span>
        {onCollapse && (
          <div className="edit-diff__head-actions">
            <button
              className="edit-diff__collapse"
              onClick={(e) => {
                e.stopPropagation();
                onCollapse();
              }}
              title="折叠预览"
              aria-label="折叠预览"
            >
              ▾
            </button>
          </div>
        )}
      </div>
      <div className="edit-diff__body edit-diff__body--multi">
        {preview.edits.map((entry, idx) => (
          <MultiEditPreviewBlock key={idx} entry={entry} index={idx} />
        ))}
      </div>
    </div>
  );
}

function MultiEditPreviewBlock({
  entry,
  index,
}: {
  entry: { oldString: string; newString: string };
  index: number;
}) {
  const oldLines = entry.oldString.replace(/\n$/, "").split("\n");
  const newLines = entry.newString.replace(/\n$/, "").split("\n");
  const MAX = 10;
  const showOld = oldLines.slice(0, MAX);
  const showNew = newLines.slice(0, MAX);
  const oldClipped = oldLines.length - showOld.length;
  const newClipped = newLines.length - showNew.length;
  return (
    <div className="edit-diff__entry">
      <div className="edit-diff__entry-head">
        <span className="edit-diff__entry-num">#{index + 1}</span>
      </div>
      {showOld.map((ln, i) => (
        <div key={`o${i}`} className="edit-diff__row edit-diff__row--del">
          <span className="edit-diff__sign">-</span>
          <span className="edit-diff__text">{ln}</span>
        </div>
      ))}
      {oldClipped > 0 && (
        <div className="edit-diff__row edit-diff__row--ellipsis">
          <span className="edit-diff__sign" />
          <span className="edit-diff__text">… (-{oldClipped} 行未显示)</span>
        </div>
      )}
      {showNew.map((ln, i) => (
        <div key={`n${i}`} className="edit-diff__row edit-diff__row--add">
          <span className="edit-diff__sign">+</span>
          <span className="edit-diff__text">{ln}</span>
        </div>
      ))}
      {newClipped > 0 && (
        <div className="edit-diff__row edit-diff__row--ellipsis">
          <span className="edit-diff__sign" />
          <span className="edit-diff__text">… (+{newClipped} 行未显示)</span>
        </div>
      )}
    </div>
  );
}

function WritePreviewCard({
  preview,
  done,
  onCollapse,
}: {
  preview: { kind: "write_file" | "append_file"; path: string; content: string };
  done?: boolean;
  onCollapse?: () => void;
}) {
  const lines = preview.content.replace(/\n$/, "").split("\n");
  const MAX = 18;
  const shown = lines.slice(0, MAX);
  const clipped = lines.length - shown.length;
  const verb =
    preview.kind === "append_file" ? (done ? "已追加" : "即将追加") : done ? "已写入" : "即将写入";
  return (
    <div className={`edit-diff write-preview${done ? "" : " edit-diff--pending"}`}>
      <div className="edit-diff__head">
        <span className="edit-diff__path">
          {preview.path}
          <span className="edit-diff__hint">
            {verb} · {preview.content.length} chars
          </span>
        </span>
        {onCollapse && (
          <div className="edit-diff__head-actions">
            <button
              className="edit-diff__collapse"
              onClick={(e) => {
                e.stopPropagation();
                onCollapse();
              }}
              title="折叠预览"
              aria-label="折叠预览"
            >
              ▾
            </button>
          </div>
        )}
      </div>
      <div className="edit-diff__body">
        {shown.map((ln, i) => (
          <div key={i} className="edit-diff__row edit-diff__row--add write-preview__row">
            <span className="edit-diff__sign">+</span>
            <span className="edit-diff__text">{ln}</span>
          </div>
        ))}
        {clipped > 0 && (
          <div className="edit-diff__row edit-diff__row--ellipsis write-preview__row">
            <span className="edit-diff__sign" />
            <span className="edit-diff__text">… (+{clipped} 行未显示)</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Unified, render-ready view of a completed file change for the thumbnail
 * diff. Both `edit_file` and `multi_edit` collapse to the same shape: the full
 * before/after file contents (the visible diff is computed client-side by
 * `buildUnifiedDiff`), the aggregate +/- counts, and a representative start
 * line for the gray `edit line N` meta.
 */
interface FileDiff {
  kind: "edit_file" | "multi_edit";
  before: string;
  after: string;
  added: number;
  removed: number;
  startLine?: number;
  editsCount: number;
}

/** Normalized terminal-command result backing the run in/out card. */
interface RunIo {
  command: string;
  cwd?: string;
  exitCode: number | null;
  signal?: string | null;
  durationMs?: number;
  stdout: string;
  stderr: string;
  /** Set when the run failed to launch / threw, as opposed to a nonzero exit. */
  errorMessage?: string;
}

/** Cached tool calls wrap the real payload in `{ cached, previous }`. */
function unwrapToolResult(result: unknown): unknown {
  if (isCachedToolResult(result) && result.previous !== undefined) return result.previous;
  return result;
}

/**
 * Reduce a completed `write` step (edit_file / multi_edit) to a single
 * `FileDiff`. Returns null for whole-file writes (write_file / append_file),
 * moves, deletes, etc. — those have no before/after pair to diff.
 */
function extractFileDiff(step: Extract<ChatStep, { kind: "tool" }>): FileDiff | null {
  if (step.tool !== "write") return null;
  const result = unwrapToolResult(step.result);
  const edit = extractEditDiff(result);
  if (edit) {
    return {
      kind: "edit_file",
      before: edit.before,
      after: edit.after,
      added: edit.added,
      removed: edit.removed,
      startLine: edit.startLine,
      editsCount: 1,
    };
  }
  const multi = extractMultiEditDiff(result);
  if (multi) {
    return {
      kind: "multi_edit",
      before: multi.before,
      after: multi.after,
      added: multi.added,
      removed: multi.removed,
      startLine: multi.edits[0]?.startLine,
      editsCount: multi.edits.length,
    };
  }
  return null;
}

/** Command + cwd from a `run` step's tool args (used for both preview and io). */
function extractRunPreview(args: unknown): { command: string; cwd?: string } | null {
  if (!args || typeof args !== "object") return null;
  const a = args as { command?: unknown; cwd?: unknown };
  if (typeof a.command !== "string") return null;
  return {
    command: a.command,
    cwd: typeof a.cwd === "string" && a.cwd ? a.cwd : undefined,
  };
}

/** Normalize a completed/failed `run` step into a `RunIo` for the in/out card. */
function extractRunIo(step: Extract<ChatStep, { kind: "tool" }>): RunIo | null {
  if (step.tool !== "run") return null;
  const preview = extractRunPreview(step.args);
  const command = preview?.command ?? "";
  const cwd = preview?.cwd;
  const result = unwrapToolResult(step.result);
  if (result && typeof result === "object") {
    const r = result as {
      ok?: unknown;
      message?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      exitCode?: unknown;
      signal?: unknown;
      durationMs?: unknown;
    };
    // Backend error payload: { ok: false, message }.
    if (r.ok === false && typeof r.message === "string") {
      return { command, cwd, exitCode: null, stdout: "", stderr: "", errorMessage: r.message };
    }
    return {
      command,
      cwd,
      exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
      signal: typeof r.signal === "string" ? r.signal : null,
      durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  }
  // No result object — surface the step error (e.g. denied / launch failure).
  if (step.error) {
    return { command, cwd, exitCode: null, stdout: "", stderr: "", errorMessage: step.error };
  }
  return null;
}

function extractEditDiff(result: unknown): EditFileDiff | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { kind?: unknown; diff?: unknown };
  if (r.kind !== "edit_file") return null;
  const d = r.diff;
  if (!d || typeof d !== "object") return null;
  const x = d as Partial<EditFileDiff>;
  if (
    typeof x.oldString !== "string" ||
    typeof x.newString !== "string" ||
    typeof x.before !== "string" ||
    typeof x.after !== "string" ||
    typeof x.startLine !== "number" ||
    typeof x.added !== "number" ||
    typeof x.removed !== "number"
  ) {
    return null;
  }
  return {
    oldString: x.oldString,
    newString: x.newString,
    startLine: x.startLine,
    endLineBefore: typeof x.endLineBefore === "number" ? x.endLineBefore : x.startLine,
    endLineAfter: typeof x.endLineAfter === "number" ? x.endLineAfter : x.startLine,
    added: x.added,
    removed: x.removed,
    before: x.before,
    after: x.after,
  };
}

function extractMultiEditDiff(result: unknown): MultiEditDiff | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { kind?: unknown; diff?: unknown };
  if (r.kind !== "multi_edit") return null;
  const d = r.diff;
  if (!d || typeof d !== "object") return null;
  const x = d as Partial<MultiEditDiff>;
  if (
    !Array.isArray(x.edits) ||
    typeof x.before !== "string" ||
    typeof x.after !== "string" ||
    typeof x.added !== "number" ||
    typeof x.removed !== "number"
  ) {
    return null;
  }
  const edits: MultiEditEntry[] = [];
  for (const e of x.edits) {
    if (!e || typeof e !== "object") return null;
    const y = e as Partial<MultiEditEntry>;
    if (
      typeof y.oldString !== "string" ||
      typeof y.newString !== "string" ||
      typeof y.startLine !== "number" ||
      typeof y.added !== "number" ||
      typeof y.removed !== "number"
    ) {
      return null;
    }
    edits.push({
      oldString: y.oldString,
      newString: y.newString,
      startLine: y.startLine,
      endLineBefore: typeof y.endLineBefore === "number" ? y.endLineBefore : y.startLine,
      endLineAfter: typeof y.endLineAfter === "number" ? y.endLineAfter : y.startLine,
      added: y.added,
      removed: y.removed,
    });
  }
  return {
    edits,
    added: x.added,
    removed: x.removed,
    before: x.before,
    after: x.after,
  };
}

function extractEditPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as { path?: unknown };
  return typeof a.path === "string" ? a.path : null;
}

// ─── Slash menu (with Model picker as first section) ───

function SlashMenu({
  onClose,
  onClear,
  onOpenSettings,
  onAutoAllow,
}: {
  onClose: () => void;
  onClear: () => void;
  onOpenSettings: () => void;
  onAutoAllow: () => void;
}) {
  return (
    <>
      <div className="chat-composer__slash-backdrop" onClick={onClose} />
      <div className="chat-composer__slash">
        <div className="chat-composer__slash-section">Context</div>
        <button className="chat-composer__slash-item is-disabled" disabled>
          Attach file
          <span className="chat-composer__slash-hint">敬请期待</span>
        </button>
        <button className="chat-composer__slash-item is-disabled" disabled>
          Mention file from this project
          <span className="chat-composer__slash-hint">敬请期待</span>
        </button>
        <button className="chat-composer__slash-item" onClick={onClear}>
          Clear conversation
        </button>
        <button className="chat-composer__slash-item is-disabled" disabled>
          Rewind <span className="chat-composer__slash-hint">敬请期待</span>
        </button>
        <div className="chat-composer__slash-section">Tools</div>
        <button className="chat-composer__slash-item" onClick={onAutoAllow}>
          Auto-allow commands
        </button>
        <button className="chat-composer__slash-item is-disabled" disabled>
          Add MCP server
          <span className="chat-composer__slash-hint">敬请期待</span>
        </button>
        <div className="chat-composer__slash-section">Settings</div>
        <button className="chat-composer__slash-item" onClick={onOpenSettings}>
          Open settings
          <span className="chat-composer__slash-hint">编辑器 / CLI 说明</span>
        </button>
      </div>
    </>
  );
}

// Auto-allow panel (redesigned)

interface AutoAllowEntry {
  key: keyof AiAutoAllow;
  label: string;
  hint: string;
  icon: React.ReactNode;
  group: string;
}

const AUTO_ALLOW_ENTRIES: AutoAllowEntry[] = [
  {
    key: "read",
    group: "读取（safe）",
    label: "Read 文件 / 列目录 / 搜索",
    hint: "不会改变工作区内容，默认允许",
    icon: <EyeIcon />,
  },
  {
    key: "write",
    group: "写入",
    label: "Write 写入 / 创建 / 删除 / 重命名",
    hint: "改动工作区文件",
    icon: <PencilIcon />,
  },
  {
    key: "runNetwork",
    group: "网络",
    label: "Network — curl / wget / ping / dig / ssh",
    hint: "对外发起网络请求",
    icon: <GlobeIcon />,
  },
  {
    key: "runInstall",
    group: "安装",
    label: "Install — npm i / pnpm / pip / brew / apt",
    hint: "下载并安装第三方依赖",
    icon: <DownloadIcon />,
  },
  {
    key: "runGit",
    group: "Git",
    label: "Git — status / log / diff / branch / fetch",
    hint: "本地版本控制操作",
    icon: <BranchIcon />,
  },
  {
    key: "runTest",
    group: "测试 / 构建",
    label: "Test — npm test / vitest / pytest / make",
    hint: "运行项目测试或构建脚本",
    icon: <CheckCircleIcon />,
  },
  {
    key: "runOther",
    group: "其它命令",
    label: "Run other — 任意 shell 命令",
    hint: "未归类的 shell 调用",
    icon: <TerminalIcon />,
  },
];

function AutoAllowPanel({
  value,
  onChange,
  onClose,
}: {
  value: AiAutoAllow;
  onChange: (v: AiAutoAllow) => void;
  onClose: () => void;
}) {
  const [local, setLocal] = useState<AiAutoAllow>(value);
  return (
    <div className="auto-allow-panel-v2">
      <div className="auto-allow-panel-v2__title">
        <span className="auto-allow-panel-v2__title-icon">
          <ShieldIcon />
        </span>
        自动执行的命令类型
      </div>
      <div className="auto-allow-panel-v2__subtitle">
        勾选的分类会被 osheep code 自动执行；未勾选的会在调用前弹窗确认。
      </div>
      {AUTO_ALLOW_ENTRIES.map((e) => (
        <div key={e.key} className="auto-allow-panel-v2__group">
          <div className="auto-allow-panel-v2__group-label">{e.group}</div>
          <label className="auto-allow-panel-v2__row">
            <input
              type="checkbox"
              className="auto-allow-panel-v2__check"
              checked={!!local[e.key]}
              onChange={(ev) => setLocal({ ...local, [e.key]: ev.target.checked })}
            />
            <span className="auto-allow-panel-v2__row-icon">{e.icon}</span>
            <div className="auto-allow-panel-v2__row-body">
              <div className="auto-allow-panel-v2__row-label">{e.label}</div>
              <div className="auto-allow-panel-v2__row-hint">{e.hint}</div>
            </div>
          </label>
        </div>
      ))}
      <div className="auto-allow-panel-v2__foot">
        命令分类基于命令首字符串识别（如 `curl` → Network、`git ...` → Git）， 具体规则见
        frontend/src/workbench/run-classify.ts。
      </div>
      <div className="auto-allow-panel-v2__actions">
        <button className="ghost-btn" onClick={onClose}>
          取消
        </button>
        <button
          className="primary-btn"
          onClick={() => {
            onChange(local);
            onClose();
          }}
        >
          保存
        </button>
      </div>
    </div>
  );
}

function ToolConfirmBar({
  call,
  categoryLabel,
  onAllow,
  onDeny,
  onFeedback,
}: {
  call: { id: string; tool: ToolKind; args: unknown };
  categoryLabel: string;
  onAllow: () => void;
  onDeny: () => void;
  onFeedback: (text: string) => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const summary = summarizeTool(call.tool, call.args);
  const submitFeedback = () => {
    const text = feedbackText.trim();
    if (!text) return;
    onFeedback(text);
  };
  return (
    <div className="tool-confirm tool-confirm--compact">
      <div className="tool-confirm__body">
        <div className="tool-confirm__title">
          osheep code 想要 {labelForTool(call.tool, call.args)}（{categoryLabel}）
        </div>
        <pre className="tool-confirm__detail">{summary}</pre>
        {feedbackOpen && (
          <div className="tool-confirm__feedback">
            <input
              className="tool-confirm__feedback-input"
              value={feedbackText}
              placeholder="手动输入给 AI 的指示…"
              onChange={(e) => setFeedbackText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitFeedback();
                if (e.key === "Escape") setFeedbackOpen(false);
              }}
            />
            <button
              className="tool-confirm__button"
              onClick={submitFeedback}
              disabled={!feedbackText.trim()}
            >
              发送
            </button>
          </div>
        )}
      </div>
      <div className="tool-confirm__actions">
        <button className="tool-confirm__button" onClick={onAllow}>
          是
        </button>
        <button className="tool-confirm__button" onClick={onDeny}>
          否
        </button>
        <button className="tool-confirm__button" onClick={() => setFeedbackOpen((v) => !v)}>
          其他
        </button>
      </div>
    </div>
  );
}

function AskPromptDialog({
  ask,
  disabled,
  onAnswer,
}: {
  ask: Extract<ChatStep, { kind: "ask" }>;
  disabled: boolean;
  onAnswer: (text: string) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [manualText, setManualText] = useState("");
  const otherIndex = ask.options.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onAnswer("取消：请根据现有信息继续，或提出更具体的问题。");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAnswer]);
  const submit = () => {
    if (selected === otherIndex) {
      const text = manualText.trim();
      if (text) onAnswer(text);
      return;
    }
    const option = ask.options[selected];
    if (option) onAnswer(option);
  };
  return (
    <div className="ask-dialog__backdrop" role="presentation">
      <div className="ask-dialog" role="dialog" aria-modal="true" aria-label="osheep code question">
        <div className="ask-dialog__head">
          <div className="ask-dialog__tabs">
            <span className="ask-dialog__tab is-active">Ask</span>
          </div>
          <button
            className="ask-dialog__close"
            onClick={() => onAnswer("取消：请根据现有信息继续，或提出更具体的问题。")}
            disabled={disabled}
            aria-label="关闭询问框"
            title="关闭"
          >
            ×
          </button>
        </div>
        <div className="ask-dialog__question">{ask.question}</div>
        <div className="ask-dialog__options">
          {ask.options.map((option, idx) => (
            <label key={idx} className="ask-dialog__option">
              <input
                type="radio"
                name={ask.id ?? "ask"}
                checked={selected === idx}
                onChange={() => setSelected(idx)}
                disabled={disabled}
              />
              <span className="ask-dialog__option-body">
                <span className="ask-dialog__option-title">{option}</span>
              </span>
            </label>
          ))}
          <label className="ask-dialog__option ask-dialog__option--other">
            <input
              type="radio"
              name={ask.id ?? "ask"}
              checked={selected === otherIndex}
              onChange={() => setSelected(otherIndex)}
              disabled={disabled}
            />
            <span className="ask-dialog__option-body">
              <span className="ask-dialog__option-title">Other</span>
              <input
                className="ask-dialog__other-input"
                value={manualText}
                placeholder="Type your answer..."
                disabled={disabled || selected !== otherIndex}
                onFocus={() => setSelected(otherIndex)}
                onChange={(e) => setManualText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </span>
          </label>
        </div>
        <button
          className="ask-dialog__submit"
          onClick={submit}
          disabled={disabled || (selected === otherIndex && !manualText.trim())}
        >
          1&nbsp; Submit answers
        </button>
        <div className="ask-dialog__esc">Esc to cancel</div>
      </div>
    </div>
  );
}

interface EditConfirmPreviewData {
  path: string;
  oldString: string;
  newString: string;
}

interface MultiEditConfirmPreviewData {
  path: string;
  edits: Array<{ oldString: string; newString: string }>;
}

function extractEditConfirmPreview(args: unknown): EditConfirmPreviewData | null {
  if (!args || typeof args !== "object") return null;
  const a = args as {
    kind?: unknown;
    path?: unknown;
    oldString?: unknown;
    newString?: unknown;
  };
  if (a.kind !== "edit_file") return null;
  if (
    typeof a.path !== "string" ||
    typeof a.oldString !== "string" ||
    typeof a.newString !== "string"
  ) {
    return null;
  }
  return { path: a.path, oldString: a.oldString, newString: a.newString };
}

function extractWriteContentPreview(
  args: unknown,
): { kind: "write_file" | "append_file"; path: string; content: string } | null {
  if (!args || typeof args !== "object") return null;
  const a = args as { kind?: unknown; path?: unknown; content?: unknown };
  if (a.kind !== "write_file" && a.kind !== "append_file") return null;
  if (typeof a.path !== "string" || typeof a.content !== "string") return null;
  return { kind: a.kind, path: a.path, content: a.content };
}

function extractMultiEditConfirmPreview(args: unknown): MultiEditConfirmPreviewData | null {
  if (!args || typeof args !== "object") return null;
  const a = args as {
    kind?: unknown;
    path?: unknown;
    edits?: unknown;
  };
  if (a.kind !== "multi_edit") return null;
  if (typeof a.path !== "string" || !Array.isArray(a.edits) || a.edits.length === 0) {
    return null;
  }
  const edits: Array<{ oldString: string; newString: string }> = [];
  for (const e of a.edits) {
    if (!e || typeof e !== "object") return null;
    const o = (e as { oldString?: unknown }).oldString;
    const n = (e as { newString?: unknown }).newString;
    if (typeof o !== "string" || typeof n !== "string") return null;
    edits.push({ oldString: o, newString: n });
  }
  return { path: a.path, edits };
}

// ───────────────── Helpers ─────────────────

function toolLineMeta(
  step: Extract<ChatStep, { kind: "tool" }>,
  fileDiff: FileDiff | null,
): string {
  if (step.tool === "read" && step.args && typeof step.args === "object") {
    const a = step.args as { kind?: unknown; startLine?: unknown; lineCount?: unknown };
    if (a.kind === "file" && typeof a.startLine === "number") {
      const end =
        typeof a.lineCount === "number" ? a.startLine + Math.max(1, a.lineCount) - 1 : null;
      return end ? `read line ${a.startLine}-${end}` : `read line ${a.startLine}`;
    }
  }
  if (step.tool === "write" && step.args && typeof step.args === "object") {
    const a = step.args as { kind?: unknown };
    if (
      (a.kind === "edit_file" || a.kind === "multi_edit") &&
      fileDiff &&
      typeof fileDiff.startLine === "number"
    ) {
      return `edit line ${fileDiff.startLine}`;
    }
    if (a.kind === "write_file" || a.kind === "append_file") return "write line 1";
  }
  return "";
}

function labelForTool(t: ToolKind, args?: unknown): string {
  if (t === "read") {
    if (args && typeof args === "object") {
      const a = args as { kind?: unknown };
      if (a.kind === "list") return "List";
      if (a.kind === "search") return "Search";
    }
    return "Read";
  }
  if (t === "write") {
    if (args && typeof args === "object") {
      const a = args as { kind?: unknown };
      if (a.kind === "edit_file") return "Edit";
      if (a.kind === "multi_edit") return "Edit";
      if (a.kind === "append_file") return "Append";
      if (a.kind === "move") return "Move";
      if (a.kind === "delete") return "Delete";
      if (a.kind === "create") return "Create";
    }
    return "Write";
  }
  return "Run";
}

function summarizeTool(t: ToolKind, args: unknown): string {
  if (!args || typeof args !== "object") return JSON.stringify(args);
  const a = args as Record<string, unknown>;
  if (t === "run") {
    const cmd = typeof a.command === "string" ? a.command : "";
    const cwd = typeof a.cwd === "string" && a.cwd ? ` (cwd=${a.cwd})` : "";
    return `$ ${cmd}${cwd}`;
  }
  if (t === "read") {
    if (a.kind === "file" && typeof a.path === "string") return a.path;
    if (a.kind === "list" && typeof a.path === "string") return `list ${a.path || "/"}`;
    if (a.kind === "search" && typeof a.query === "string") return `search "${a.query}"`;
    return JSON.stringify(a);
  }
  // write — emit `path` plus a kind-specific tail. We deliberately suppress
  // the `content` / `newString` payload (which can be tens of KB) so the
  // timeline row and the confirm sheet stay readable. For `edit_file` the
  // dedicated +N/-M counter and the thumbnail-diff card cover what the user
  // needs to see, so we keep the inline summary to just the path.
  const kind = typeof a.kind === "string" ? a.kind : "";
  const path = typeof a.path === "string" ? a.path : typeof a.to === "string" ? a.to : "";
  if (kind === "edit_file") return path;
  if (kind === "multi_edit") {
    const editsLen = Array.isArray(a.edits) ? a.edits.length : 0;
    return `${path} (${editsLen} edit${editsLen === 1 ? "" : "s"})`;
  }
  if (kind === "move" && typeof a.from === "string") {
    return `${a.from} → ${a.to ?? ""}`;
  }
  if (kind === "delete") return path + (a.recursive ? " (recursive)" : "");
  if (kind === "create") {
    const ek = typeof a.entryKind === "string" ? a.entryKind : "file";
    return `${ek} ${path}`;
  }
  const sizeHint = typeof a.content === "string" ? ` (+${a.content.length} chars)` : "";
  return `${path}${sizeHint}`.trim() || kind || "write";
}

function prettyToolResult(t: ToolKind, result: unknown): string {
  if (isCachedToolResult(result)) {
    const parts: string[] = [];
    parts.push(result.message || "Duplicate tool call skipped; reused cached result.");
    if (result.previousError) parts.push(`previous error: ${result.previousError}`);
    if (result.previous !== undefined) {
      parts.push(`--- previous result ---\n${prettyUnknown(result.previous)}`);
    }
    return parts.join("\n");
  }
  if (t === "run") {
    const r = result as {
      shell?: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      signal?: string | null;
      durationMs?: number;
    };
    const parts: string[] = [];
    parts.push(
      `exit=${r.exitCode ?? "null"}${r.signal ? `, signal=${r.signal}` : ""}, ${r.durationMs ?? 0}ms${r.shell ? `, shell=${r.shell}` : ""}`,
    );
    if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`);
    if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
    return parts.join("\n");
  }
  if (t === "read") {
    const r = result as {
      kind?: string;
      content?: string;
      entries?: unknown[];
      matches?: unknown[];
    };
    if (r.kind === "file") return r.content ?? "";
    if (r.kind === "list") return JSON.stringify(r.entries ?? [], null, 2);
    if (r.kind === "search") return JSON.stringify(r.matches ?? [], null, 2);
  }
  return JSON.stringify(result, null, 2);
}

function isCachedToolResult(result: unknown): result is {
  cached: true;
  message?: string;
  previous?: unknown;
  previousError?: string;
} {
  return !!result && typeof result === "object" && (result as { cached?: unknown }).cached === true;
}

function prettyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

// Unused — kept to preserve API for callers that might import it.

// ─── Icons ───

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function SlashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <rect
        x="2.5"
        y="2.5"
        width="11"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
      <path
        d="M10 5l-4 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M8 13V3M3.5 7.5L8 3l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
      <path
        d="M3 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function CachedIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
      <path
        d="M4.5 7a3.5 3.5 0 015.9-2.5L12 6M11.5 9a3.5 3.5 0 01-5.9 2.5L4 10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M12 3.5V6H9.5M4 12.5V10h2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M8 1.5L2.5 3.5v3.8c0 3.2 2.4 6 5.5 7.2 3.1-1.2 5.5-4 5.5-7.2V3.5L8 1.5z"
        fill="currentColor"
        opacity="0.85"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M3 13l1-3 7-7 2.5 2.5-7 7-3 1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path
        d="M2.5 8h11M8 2.5c2.2 2 2.2 9 0 11M8 2.5c-2.2 2-2.2 9 0 11"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="none"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M8 2v8M4 7l4 4 4-4M3 13.5h10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <circle cx="4.5" cy="3" r="1.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="4.5" cy="13" r="1.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="11.5" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path
        d="M4.5 4.6v6.8M4.5 6c0 2.2 2 3 3.5 3h2"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path
        d="M5.5 8.2l2 2 3.5-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <rect
        x="1.8"
        y="3.5"
        width="12.4"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
      <path
        d="M4.5 6.5l2.2 2-2.2 2M8 10.5h3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
