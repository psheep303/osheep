import { useEffect, useMemo, useRef, useState } from "react";
import {
  getSession as apiGetSession,
  saveSession as apiSaveSession,
  type ChatMessage,
  type ChatStep,
  type SessionRecord,
  type ToolKind,
} from "./api";
import { ChatMarkdown } from "./ChatMarkdown";
import { chatRuntime, useChatTurn } from "./chat-runtime";
import type {
  AiAutoAllow,
  AiProvider,
  OsheepSettings,
  ReasoningEffort,
} from "./settings";
import {
  DEFAULT_AUTO_ALLOW,
  detectReasoningKind,
  effortKey,
  effortLevels,
  resolveDefaultProviderModel,
  resolveEffort,
} from "./settings";

interface ChatTabProps {
  workspaceId: string;
  sessionId: string;
  settings: OsheepSettings;
  onSettingsChange: (next: OsheepSettings) => void;
  onSessionChanged: () => void;
  onOpenSettings: () => void;
}

export function ChatTab({
  workspaceId,
  sessionId,
  settings,
  onSettingsChange,
  onSessionChanged,
  onOpenSettings,
}: ChatTabProps) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const view = useChatTurn(sessionId);
  const sending = view.status === "running" || view.status === "awaiting-confirm";

  const { providerId, model } = useMemo(
    () => resolveDefaultProviderModel(settings),
    [settings]
  );

  const provider: AiProvider | null = useMemo(
    () => settings.ai.providers.find((p) => p.id === providerId) ?? null,
    [providerId, settings.ai.providers]
  );

  const effort = useMemo<ReasoningEffort | null>(() => {
    if (!provider || !model) return null;
    return resolveEffort(settings, provider.id, model, provider.kind);
  }, [provider, model, settings]);

  const autoAllow: AiAutoAllow = settings.ai.autoAllow ?? DEFAULT_AUTO_ALLOW;

  const [slashOpen, setSlashOpen] = useState(false);
  const [slashSection, setSlashSection] = useState<"root" | "model">("root");
  const [autoAllowOpen, setAutoAllowOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Tracks whether the user is currently pinned to the bottom of the
  // conversation. We only auto-scroll on new content if they are — so
  // reading older messages mid-stream isn't yanked back to the bottom.
  const stickToBottomRef = useRef(true);
  // Set by handleSend so the next render forces a scroll-to-bottom even if
  // the user wasn't pinned (sending a new message should always reveal the
  // assistant reply that's about to appear).
  const forceScrollToBottomRef = useRef(false);

  // Load the session record on mount / session-switch.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
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
    ta.style.height = next + "px";
  }, [input]);

  // Auto-scroll: only if the user is "stuck to the bottom", or if we just
  // sent a new user message (forceScrollToBottomRef). User scrolling up to
  // read history will unstick the view; scrolling back near the bottom
  // re-sticks it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (forceScrollToBottomRef.current || stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      forceScrollToBottomRef.current = false;
      stickToBottomRef.current = true;
    }
  }, [
    session?.messages.length,
    sending,
    view.pendingSteps.length,
    view.pendingText,
  ]);

  // Update the "is near bottom" tracker as the user scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const slack = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = slack < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const readyToSend =
    !!provider && !!provider.baseUrl && !!provider.apiKey && !!model;

  const sendBlockReason = !provider
    ? "请先在「设置」中选择默认 Provider"
    : !provider.baseUrl || !provider.apiKey
    ? "默认 Provider 缺少 Base URL 或 API Key（请在设置中填写）"
    : !model
    ? "请先在「设置」中选择默认 Model"
    : "";

  const stopStream = () => {
    chatRuntime.stop(sessionId);
  };

  const updateAutoAllow = (next: AiAutoAllow) => {
    onSettingsChange({
      ...settings,
      ai: { ...settings.ai, autoAllow: next },
    });
  };

  const setDefaultModel = (pid: string, m: string) => {
    onSettingsChange({
      ...settings,
      ai: {
        ...settings.ai,
        defaultProviderId: pid,
        defaultModel: m,
      },
    });
  };

  const setEffort = (next: ReasoningEffort | null) => {
    if (!provider || !model || !next) return;
    const map = { ...(settings.ai.reasoningEffort ?? {}) };
    map[effortKey(provider.id, model)] = next;
    onSettingsChange({
      ...settings,
      ai: { ...settings.ai, reasoningEffort: map },
    });
  };

  const clearConversation = async () => {
    if (!session) return;
    if (!window.confirm("清空当前对话的所有消息？")) return;
    const next: SessionRecord = {
      ...session,
      messages: [],
      providerId: provider?.id ?? session.providerId,
      model: model || session.model,
    };
    try {
      const saved = await apiSaveSession(workspaceId, next);
      setSession(saved);
      onSessionChanged();
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  const handleSend = () => {
    if (!session) return;
    const text = input.trim();
    if (!text) return;
    if (!readyToSend || !provider) return;

    // chatRuntime.send handles the "queue on top of a running turn" case
    // internally — it aborts the current upstream stream, resolves any
    // pending tool-confirm as deny, and reruns with the new payload once
    // the previous loop unwinds.
    forceScrollToBottomRef.current = true;
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
        getSession: () => sessionRef.current,
        setSession: (s) => {
          sessionRef.current = s;
          setSession(s);
        },
        getAutoAllow: () => settingsRef.current.ai.autoAllow ?? DEFAULT_AUTO_ALLOW,
      },
    });
  };

  if (loading) return <div className="empty-hint">加载中…</div>;
  if (!session)
    return <div className="empty-hint">{loadError ?? "未能加载该对话"}</div>;

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
      setSlashSection("root");
    }
  };

  return (
    <div className="chat-tab">
      <div className="chat-tab__messages" ref={scrollRef}>
        <div className="chat-tab__messages-inner">
          {session.messages.length === 0 && !sending && (
            <div className="chat-tab__welcome">
              <div className="chat-tab__welcome-title">
                {session.title || "新对话"}
              </div>
              <div className="chat-tab__welcome-hint">
                {readyToSend
                  ? "向 osheep code 描述你的任务"
                  : sendBlockReason}
              </div>
            </div>
          )}
          {session.messages.map((m, i) => (
            <MessageBlock key={i} message={m} />
          ))}
          {sending && (
            <PendingAssistant
              steps={view.pendingSteps}
              text={view.pendingText}
              status={view.status}
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
            aria-label="关闭错误提示"
          >
            ×
          </button>
        </div>
      )}

      {view.pendingConfirm && (
        <ToolConfirmBar
          call={view.pendingConfirm.call}
          categoryLabel={view.pendingConfirm.category.label}
          onAlways={() => chatRuntime.resolveConfirm(sessionId, "always")}
          onOnce={() => chatRuntime.resolveConfirm(sessionId, "once")}
          onDeny={() => chatRuntime.resolveConfirm(sessionId, "deny")}
        />
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
          className={
            "chat-composer" +
            (sending ? " is-busy" : "") +
            (!readyToSend ? " is-blocked" : "")
          }
        >
          <textarea
            ref={textareaRef}
            className="chat-composer__input"
            value={input}
            rows={1}
            placeholder={
              readyToSend
                ? "描述你想做的事…  ( /  打开菜单 )"
                : sendBlockReason || "描述你想做的事…"
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="chat-composer__row">
            <div className="chat-composer__row-left">
              <button
                className="chat-composer__icon-btn"
                title="附加上下文（敬请期待）"
                disabled
                tabIndex={-1}
              >
                <PlusIcon />
              </button>
              <button
                className="chat-composer__icon-btn"
                title="斜杠菜单"
                onClick={() => {
                  setSlashOpen((v) => !v);
                  setSlashSection("root");
                }}
              >
                <SlashIcon />
              </button>
              {slashOpen && (
                <SlashMenu
                  section={slashSection}
                  setSection={setSlashSection}
                  providers={settings.ai.providers}
                  providerId={providerId}
                  model={model}
                  effort={effort}
                  onPickModel={(pid, m) => {
                    setDefaultModel(pid, m);
                  }}
                  onPickEffort={(e) => setEffort(e)}
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

              <ComposerModelChip
                provider={provider}
                model={model}
                effort={effort}
                onClick={() => {
                  setSlashOpen(true);
                  setSlashSection("model");
                }}
              />
            </div>
            <div className="chat-composer__row-right">
              {sending && !input.trim() ? (
                <button
                  className="chat-composer__send is-stop"
                  onClick={stopStream}
                  title="停止生成（Esc）"
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
                      ? "请先输入内容"
                      : sending
                      ? "停止当前任务并发送新消息（Enter）"
                      : "发送（Enter）"
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

function MessageBlock({ message }: { message: ChatMessage }) {
  if (message.role === "tool") {
    return null;
  }
  if (message.role === "user") {
    return (
      <div className="chat-msg chat-msg--user">
        <div className="chat-msg__chip">
          <span className="chat-msg__chip-dot chat-msg__chip-dot--user" />
          你
        </div>
        <div className="chat-msg__content">
          <ChatMarkdown source={message.content} />
        </div>
      </div>
    );
  }
  const steps = message.steps ?? [];
  return (
    <div className="chat-msg chat-msg--assistant">
      <div className="chat-msg__chip">
        <span className="chat-msg__chip-dot chat-msg__chip-dot--assistant" />
        osheep code
      </div>
      <div className="chat-msg__timeline">
        {steps.map((s, i) => (
          <StepRow key={i} step={s} streaming={false} />
        ))}
        {steps.length === 0 && message.content && (
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

function PendingAssistant({
  steps,
  text,
  status,
}: {
  steps: ChatStep[];
  text: string;
  status: string;
}) {
  // Treat the last step as "streaming" (gets shimmer / icon pulse). If the
  // model emits free text after the last tagged block, the floating text
  // bubble at the bottom is the streaming one instead.
  const lastIdx = text ? -1 : steps.length - 1;
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
          <StepRow key={i} step={s} streaming={i === lastIdx} />
        ))}
        {text && (
          <div className="chat-step chat-step--text is-streaming">
            <span className="chat-step__icon chat-step__icon--text" />
            <div className="chat-step__body">
              <ChatMarkdown source={text} caret />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({ step, streaming }: { step: ChatStep; streaming: boolean }) {
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
        if (/^\[[ x~]\]/i.test(trimmed)) return "- " + trimmed;
        // Bare line — assume "not done".
        return `- [ ] ${trimmed}`;
      })
      .join("\n");
    return (
      <div className={"chat-step chat-step--plan" + (streaming ? " is-streaming" : "")}>
        <span className="chat-step__icon chat-step__icon--text" />
        <div className="chat-step__body">
          <div className="chat-step__label">Plan</div>
          <ChatMarkdown source={md} compact />
        </div>
      </div>
    );
  }
  if (step.kind === "thought") {
    return (
      <div className={"chat-step chat-step--thought" + (streaming ? " is-streaming" : "")}>
        <span className="chat-step__icon chat-step__icon--text" />
        <div className="chat-step__body">
          <span className="chat-step__label">Thought</span>
          <ChatMarkdown source={step.text} compact />
        </div>
      </div>
    );
  }
  if (step.kind === "verify") {
    return (
      <div className={"chat-step chat-step--verify" + (streaming ? " is-streaming" : "")}>
        <span className="chat-step__icon chat-step__icon--text" />
        <div className="chat-step__body">
          <span className="chat-step__label">Verify</span>
          <ChatMarkdown source={step.text} compact />
        </div>
      </div>
    );
  }
  if (step.kind === "text") {
    return (
      <div className={"chat-step chat-step--text" + (streaming ? " is-streaming" : "")}>
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
      : "chat-step__icon--running";
  return <ToolStepRow step={step} iconClass={iconClass} streaming={streaming} />;
}

function ToolStepRow({
  step,
  iconClass,
  streaming,
}: {
  step: Extract<ChatStep, { kind: "tool" }>;
  iconClass: string;
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = labelForTool(step.tool);
  const summary = summarizeTool(step.tool, step.args);
  const resultText = step.result
    ? prettyToolResult(step.tool, step.result)
    : step.error
    ? step.error
    : "";
  return (
    <div className={"chat-step chat-step--tool" + (streaming ? " is-streaming" : "")}>
      <span className={"chat-step__icon " + iconClass}>
        {step.status === "ok" && <CheckIcon />}
        {(step.status === "err" || step.status === "denied") && <CrossIcon />}
        {step.status === "running" && (
          <span className="chat-step__icon-dot" aria-hidden />
        )}
      </span>
      <div className="chat-step__body">
        <button
          className="chat-step__tool-head"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="chat-step__label">{label}</span>
          <span className="chat-step__inline">{summary}</span>
        </button>
        {expanded && resultText && (
          <pre className="chat-step__tool-output">{resultText}</pre>
        )}
      </div>
    </div>
  );
}

// ─── Slash menu (with Model picker as first section) ───

function SlashMenu({
  section,
  setSection,
  providers,
  providerId,
  model,
  effort,
  onPickModel,
  onPickEffort,
  onClose,
  onClear,
  onOpenSettings,
  onAutoAllow,
}: {
  section: "root" | "model";
  setSection: (s: "root" | "model") => void;
  providers: AiProvider[];
  providerId: string;
  model: string;
  effort: ReasoningEffort | null;
  onPickModel: (pid: string, m: string) => void;
  onPickEffort: (e: ReasoningEffort) => void;
  onClose: () => void;
  onClear: () => void;
  onOpenSettings: () => void;
  onAutoAllow: () => void;
}) {
  const currentProvider = providers.find((p) => p.id === providerId);
  const reasoningKind =
    currentProvider && model
      ? detectReasoningKind(currentProvider.kind, model)
      : null;

  return (
    <>
      <div className="chat-composer__slash-backdrop" onClick={onClose} />
      <div className="chat-composer__slash">
        {section === "model" && (
          <>
            <div className="chat-composer__slash-section chat-composer__slash-section--with-back">
              <button
                className="chat-composer__slash-back"
                onClick={() => setSection("root")}
                title="返回"
              >
                ←
              </button>
              <span>Model</span>
            </div>
            <div className="slash-model-list">
              {providers.length === 0 ? (
                <div className="chat-composer__provider-empty">
                  尚未配置任何 Provider
                </div>
              ) : (
                providers.flatMap((p) =>
                  p.models.map((m) => {
                    const isActive = p.id === providerId && m === model;
                    return (
                      <button
                        key={p.id + "::" + m}
                        className="slash-model-row"
                        onClick={() => {
                          onPickModel(p.id, m);
                        }}
                      >
                        <span className="slash-model-row__kind">{p.kind}</span>
                        <span className="slash-model-row__provider">
                          {p.name || p.id}
                        </span>
                        <span className="slash-model-row__provider">/</span>
                        <span className="slash-model-row__model">{m}</span>
                        {isActive && (
                          <span className="slash-model-row__check">✓</span>
                        )}
                      </button>
                    );
                  })
                )
              )}
            </div>
            {reasoningKind && (
              <div className="slash-effort">
                <span className="slash-effort__label">Effort</span>
                {effortLevels(reasoningKind).map((lvl) => (
                  <button
                    key={lvl}
                    className={
                      "slash-effort__seg" +
                      (lvl === effort ? " is-active" : "")
                    }
                    onClick={() => onPickEffort(lvl)}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {section === "root" && (
          <>
            <div className="chat-composer__slash-section">Model</div>
            <button
              className="chat-composer__slash-item"
              onClick={() => setSection("model")}
            >
              <span>
                {currentProvider
                  ? `${currentProvider.name || currentProvider.id} / ${model || "(未选择)"}`
                  : "(未选择 Provider)"}
                {effort && effort !== "off" && (
                  <span className="chat-composer__slash-hint">{effort}</span>
                )}
              </span>
              <span className="chat-composer__slash-hint">切换 ▸</span>
            </button>
            <div className="chat-composer__slash-section">Context</div>
            <button className="chat-composer__slash-item is-disabled" disabled>
              Attach file… <span className="chat-composer__slash-hint">敬请期待</span>
            </button>
            <button className="chat-composer__slash-item is-disabled" disabled>
              Mention file from this project…{" "}
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
              Auto-allow commands…
            </button>
            <button className="chat-composer__slash-item is-disabled" disabled>
              Add MCP server…{" "}
              <span className="chat-composer__slash-hint">敬请期待</span>
            </button>
            <div className="chat-composer__slash-section">Settings</div>
            <button
              className="chat-composer__slash-item"
              onClick={onOpenSettings}
            >
              Open settings…
              <span className="chat-composer__slash-hint">
                Provider / API Key / 主题
              </span>
            </button>
          </>
        )}
      </div>
    </>
  );
}

function ComposerModelChip({
  provider,
  model,
  effort,
  onClick,
}: {
  provider: AiProvider | null;
  model: string;
  effort: ReasoningEffort | null;
  onClick: () => void;
}) {
  return (
    <button
      className="composer-model-chip"
      onClick={onClick}
      title="切换 Provider / Model / 推理强度"
    >
      <span className="composer-model-chip__provider">
        {provider ? provider.name || provider.id : "未选择"}
      </span>
      <span className="composer-model-chip__provider">/</span>
      <span className="composer-model-chip__model">{model || "—"}</span>
      {effort && effort !== "off" && (
        <span className="composer-model-chip__effort">{effort}</span>
      )}
    </button>
  );
}

// ─── Auto-allow panel (redesigned) ───

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
        <span className="auto-allow-panel-v2__title-icon"><ShieldIcon /></span>
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
              onChange={(ev) =>
                setLocal({ ...local, [e.key]: ev.target.checked })
              }
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
        命令分类基于命令首字符串识别（如 `curl` → Network、`git ...` → Git），
        具体规则见 frontend/src/workbench/run-classify.ts。
      </div>
      <div className="auto-allow-panel-v2__actions">
        <button className="ghost-btn" onClick={onClose}>取消</button>
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
  onAlways,
  onOnce,
  onDeny,
}: {
  call: { id: string; tool: ToolKind; args: unknown };
  categoryLabel: string;
  onAlways: () => void;
  onOnce: () => void;
  onDeny: () => void;
}) {
  const summary = summarizeTool(call.tool, call.args);
  return (
    <div className="tool-confirm">
      <div className="tool-confirm__icon">⚠</div>
      <div className="tool-confirm__body">
        <div className="tool-confirm__title">
          osheep code 想要 {labelForTool(call.tool)}（{categoryLabel}）：
        </div>
        <pre className="tool-confirm__detail">{summary}</pre>
      </div>
      <div className="tool-confirm__actions">
        <button className="primary-btn" onClick={onAlways}>
          始终允许 {categoryLabel}
        </button>
        <button className="ghost-btn" onClick={onOnce}>仅这一次</button>
        <button className="danger-btn" onClick={onDeny}>拒绝</button>
      </div>
    </div>
  );
}

// ───────────────── Helpers ─────────────────

function labelForTool(t: ToolKind): string {
  if (t === "read") return "Read";
  if (t === "write") return "Write";
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
    if (a.kind === "search" && typeof a.query === "string")
      return `search "${a.query}"`;
    return JSON.stringify(a);
  }
  // write — emit `kind path [+N bytes]`. We deliberately suppress the
  // `content` / `newString` payload (which can be tens of KB) so the
  // timeline row and the confirm sheet stay readable.
  const kind = typeof a.kind === "string" ? a.kind : "";
  const path =
    typeof a.path === "string"
      ? a.path
      : typeof a.to === "string"
      ? a.to
      : "";
  const sizeHint =
    typeof a.content === "string"
      ? ` (+${a.content.length} chars)`
      : typeof a.newString === "string"
      ? ` (edit ${a.newString.length} chars)`
      : "";
  return `${kind || "write"} ${path}${sizeHint}`.trim();
}

function prettyToolResult(t: ToolKind, result: unknown): string {
  if (t === "run") {
    const r = result as {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      signal?: string | null;
      durationMs?: number;
    };
    const parts: string[] = [];
    parts.push(
      `exit=${r.exitCode ?? "null"}${r.signal ? `, signal=${r.signal}` : ""}, ${r.durationMs ?? 0}ms`
    );
    if (r.stdout) parts.push("--- stdout ---\n" + r.stdout);
    if (r.stderr) parts.push("--- stderr ---\n" + r.stderr);
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

// Unused — kept to preserve API for callers that might import it.
export { resolveDefaultProviderModel };

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
      <path d="M2.5 8h11M8 2.5c2.2 2 2.2 9 0 11M8 2.5c-2.2 2-2.2 9 0 11" stroke="currentColor" strokeWidth="1.1" fill="none" />
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
      <path d="M4.5 4.6v6.8M4.5 6c0 2.2 2 3 3.5 3h2" stroke="currentColor" strokeWidth="1.2" fill="none" />
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
      <rect x="1.8" y="3.5" width="12.4" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M4.5 6.5l2.2 2-2.2 2M8 10.5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
