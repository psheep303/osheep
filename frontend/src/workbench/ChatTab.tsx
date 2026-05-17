import { useEffect, useMemo, useRef, useState } from "react";
import {
  aiChat,
  type AgentRecord,
  type AiChatMessage,
  type ChatMessage,
  type SessionRecord,
  getSession as apiGetSession,
  listAgents as apiListAgents,
  saveSession as apiSaveSession,
} from "./api";
import type { OsheepSettings } from "./settings";

interface ChatTabProps {
  workspaceId: string;
  sessionId: string;
  settings: OsheepSettings;
  /** called after a save so the AI panel re-fetches the list */
  onSessionChanged: () => void;
}

export function ChatTab({
  workspaceId,
  sessionId,
  settings,
  onSessionChanged,
}: ChatTabProps) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agentName, setAgentName] = useState<string>("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Load session + agents on mount / id change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiGetSession(workspaceId, sessionId),
      apiListAgents(workspaceId),
    ])
      .then(([s, a]) => {
        if (cancelled) return;
        setSession(s);
        setAgents(a);
        // Prefer session's previous agent if still exists
        if (s.agentName && a.some((x) => x.name === s.agentName)) {
          setAgentName(s.agentName);
        } else if (a.length > 0) {
          setAgentName(a[0]!.name);
        } else {
          setAgentName("");
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sessionId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.messages.length, sending]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.name === agentName) ?? null,
    [agents, agentName]
  );

  const provider = useMemo(() => {
    if (!selectedAgent) return null;
    return (
      settings.ai.providers.find((p) => p.id === selectedAgent.providerId) ??
      null
    );
  }, [selectedAgent, settings.ai.providers]);

  const readyToSend =
    !!selectedAgent &&
    !!provider &&
    !!provider.baseUrl &&
    !!provider.apiKey &&
    !!selectedAgent.model;

  const sendBlockReason = !selectedAgent
    ? "请先选择 Agent"
    : !provider
    ? "该 Agent 的 Provider 已不存在，请在设置中修复"
    : !provider.baseUrl || !provider.apiKey
    ? "该 Provider 缺少 Base URL 或 API Key"
    : !selectedAgent.model
    ? "该 Agent 未设置模型"
    : "";

  const send = async () => {
    if (!session) return;
    const text = input.trim();
    if (!text) return;
    if (!readyToSend || !selectedAgent || !provider) return;

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    const nextTitle =
      session.title === "新对话" || !session.title
        ? text.slice(0, 24)
        : session.title;

    const optimistic: SessionRecord = {
      ...session,
      title: nextTitle,
      agentName: selectedAgent.name,
      messages: [...session.messages, userMsg],
    };
    setSession(optimistic);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const apiMessages: AiChatMessage[] = [];
      if (selectedAgent.prompt && selectedAgent.prompt.trim()) {
        apiMessages.push({ role: "system", content: selectedAgent.prompt });
      }
      for (const m of optimistic.messages) {
        apiMessages.push({ role: m.role, content: m.content });
      }

      const { content } = await aiChat(workspaceId, {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: selectedAgent.model,
        messages: apiMessages,
      });

      const replyMsg: ChatMessage = {
        role: "assistant",
        content,
        timestamp: Date.now(),
      };
      const final: SessionRecord = {
        ...optimistic,
        messages: [...optimistic.messages, replyMsg],
      };
      const saved = await apiSaveSession(workspaceId, final);
      setSession(saved);
      onSessionChanged();
    } catch (e) {
      setError((e as Error).message);
      // Persist user message even if reply failed so context is kept
      try {
        const saved = await apiSaveSession(workspaceId, optimistic);
        setSession(saved);
        onSessionChanged();
      } catch {
        /* ignore */
      }
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <div className="empty-hint">加载中…</div>;
  }

  if (!session) {
    return (
      <div className="empty-hint">
        {error ?? "未能加载该对话"}
      </div>
    );
  }

  return (
    <div className="chat-tab">
      <div className="chat-tab__header">
        <span className="chat-tab__title">{session.title || "新对话"}</span>
        <span className="chat-tab__meta">
          {session.messages.length} 条消息
        </span>
      </div>

      <div className="chat-tab__messages" ref={scrollRef}>
        {session.messages.length === 0 && (
          <div className="empty-hint">向 Agent 发出第一条消息</div>
        )}
        {session.messages.map((m, i) => (
          <div
            key={i}
            className={"chat-msg chat-msg--" + m.role}
          >
            <div className="chat-msg__role">
              {m.role === "user" ? "你" : "助手"}
            </div>
            <div className="chat-msg__content">{m.content}</div>
          </div>
        ))}
        {sending && (
          <div className="chat-msg chat-msg--assistant chat-msg--pending">
            <div className="chat-msg__role">助手</div>
            <div className="chat-msg__content">思考中…</div>
          </div>
        )}
      </div>

      {error && (
        <div className="chat-tab__error">
          {error}
          <button
            className="provider-card__chip-remove"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      )}

      <div className="chat-tab__composer">
        <textarea
          className="chat-tab__input"
          value={input}
          placeholder={
            readyToSend
              ? "输入消息，Enter 发送，Shift+Enter 换行"
              : sendBlockReason
          }
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (readyToSend && !sending) void send();
            }
          }}
        />
        <div className="chat-tab__actions">
          <label className="chat-tab__agent-label">Agent</label>
          <select
            className="agent-card__select chat-tab__agent-select"
            value={agentName}
            disabled={sending}
            onChange={(e) => setAgentName(e.target.value)}
          >
            <option value="">— 未选择 —</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.model ? ` · ${a.model}` : ""}
              </option>
            ))}
          </select>
          <span className="chat-tab__hint">
            {readyToSend ? "" : sendBlockReason}
          </span>
          <button
            className="settings-view__seg is-active chat-tab__send"
            disabled={!readyToSend || sending || !input.trim()}
            onClick={() => void send()}
          >
            {sending ? "发送中…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
