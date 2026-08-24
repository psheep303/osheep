import { lazy, Suspense, useEffect, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { openAdapterEventsSocket } from "./api";
import type { AgentTerminalLaunchRequest } from "./Terminal";

const PlanView = lazy(() => import("./PlanView").then((module) => ({ default: module.PlanView })));
const Terminal = lazy(() => import("./Terminal").then((module) => ({ default: module.Terminal })));

type BottomTab = "terminal" | "log" | "docs";

interface BottomPanelProps {
  workspaceId: string | null;
  docsRefreshSignal?: number;
  editorFontSize?: number;
  editorTabSize?: number;
  editorAutoSave?: boolean;
  onDocsChanged?: () => void;
  onClose: () => void;
  terminalLaunchRequest?: AgentTerminalLaunchRequest | null;
  onTerminalLaunchHandled?: (key: number) => void;
  openTerminalSignal?: number;
}

export function BottomPanel({
  workspaceId,
  docsRefreshSignal = 0,
  editorFontSize = 14,
  editorTabSize = 2,
  editorAutoSave = false,
  onDocsChanged,
  onClose,
  terminalLaunchRequest = null,
  onTerminalLaunchHandled,
  openTerminalSignal = 0,
}: BottomPanelProps) {
  const { t } = useUiPreferences();
  const [tab, setTab] = useState<BottomTab>("terminal");
  const [docsMounted, setDocsMounted] = useState(false);

  useEffect(() => {
    if (terminalLaunchRequest) setTab("terminal");
  }, [terminalLaunchRequest]);

  useEffect(() => {
    if (openTerminalSignal > 0) setTab("terminal");
  }, [openTerminalSignal]);

  return (
    <div className="bottom-panel">
      <div className="bottom-panel__tabs">
        <div
          className={`bottom-panel__tab${tab === "terminal" ? " is-active" : ""}`}
          onClick={() => setTab("terminal")}
        >
          {t("panel.terminal")}
        </div>
        <div
          className={`bottom-panel__tab${tab === "log" ? " is-active" : ""}`}
          onClick={() => setTab("log")}
        >
          {t("panel.log")}
        </div>
        <div
          className={`bottom-panel__tab${tab === "docs" ? " is-active" : ""}`}
          onClick={() => {
            setDocsMounted(true);
            setTab("docs");
          }}
        >
          {t("panel.docs")}
        </div>
        <button className="icon-btn bottom-panel__close" title={t("panel.close")} onClick={onClose}>
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="bottom-panel__body">
        <Suspense fallback={<div className="tab-loading-fallback" />}>
          <div
            className={`bottom-panel__pane${tab === "terminal" ? " is-active" : ""}`}
            aria-hidden={tab !== "terminal"}
          >
            <Terminal
              workspaceId={workspaceId}
              launchRequest={terminalLaunchRequest}
              onLaunchHandled={onTerminalLaunchHandled}
            />
          </div>
          {tab === "log" && (
            <div className="bottom-panel__pane is-active">
              <AdapterLogView workspaceId={workspaceId} />
            </div>
          )}
          {docsMounted && (
            <div
              className={`bottom-panel__pane${tab === "docs" ? " is-active" : ""}`}
              aria-hidden={tab !== "docs"}
            >
              <PlanView
                workspaceId={workspaceId}
                refreshSignal={docsRefreshSignal}
                editorFontSize={editorFontSize}
                editorTabSize={editorTabSize}
                autoSave={editorAutoSave}
                onDocsChanged={onDocsChanged}
              />
            </div>
          )}
        </Suspense>
      </div>
    </div>
  );
}

function AdapterLogView({ workspaceId }: { workspaceId: string | null }) {
  const { t } = useUiPreferences();
  const [events, setEvents] = useState<AdapterLogEvent[]>([]);
  const [sessions, setSessions] = useState<AdapterSessionInfo[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (cancelled) return;
      socket = openAdapterEventsSocket(workspaceId ?? undefined);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (message) => {
        try {
          const value = JSON.parse(message.data) as AdapterLogMessage;
          if (value.type === "ready") {
            setSessions(value.sessions ?? []);
            return;
          }
          if (typeof value.type !== "string") return;
          const sessionId = value.sessionId;
          if (sessionId) {
            setSessions((current) => {
              const existing = current.find((session) => session.id === sessionId);
              if (existing) {
                return current.map((session) =>
                  session.id === sessionId
                    ? {
                        ...session,
                        adapterId: value.adapterId ?? session.adapterId,
                        state: value.state ?? session.state,
                        updatedAt: value.timestamp ?? session.updatedAt,
                      }
                    : session,
                );
              }
              return [
                ...current,
                {
                  id: sessionId,
                  adapterId: value.adapterId ?? "unknown",
                  state: value.state ?? "running",
                  updatedAt: value.timestamp ?? Date.now(),
                },
              ];
            });
          }
          setEvents((current) => [...current, value].slice(-200));
        } catch {
          // Ignore malformed frames from a disconnected or older backend.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!cancelled) retryTimer = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      cancelled = true;
      setConnected(false);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [workspaceId]);

  return (
    <div className="adapter-log">
      <div className="adapter-log__summary">
        <span className={`adapter-log__connection${connected ? " is-live" : ""}`}>
          <span className="adapter-log__dot" aria-hidden="true" />
          {connected ? t("panel.logLive") : t("panel.logConnecting")}
        </span>
        <span className="adapter-log__count">
          {events.length} / {sessions.length} {t("panel.logCounts")}
        </span>
      </div>
      {events.length === 0 ? (
        <div className="bottom-panel__log-state">{t("panel.logEmpty")}</div>
      ) : (
        <div className="adapter-log__events" role="log" aria-live="polite">
          {events.map((event) => (
            <AdapterLogEventRow
              event={event}
              key={event.id ?? `${event.timestamp}-${event.sequence}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface AdapterSessionInfo {
  id: string;
  adapterId: string;
  state: string;
  updatedAt: number;
}

interface AdapterLogEvent {
  id?: string;
  sequence?: number;
  timestamp?: number;
  sessionId?: string;
  adapterId?: string;
  type: string;
  state?: string;
  reason?: string;
  error?: string;
  frameType?: string;
  frameStatus?: string;
  frameSessionId?: string;
  workflowId?: string;
  node?: { title?: string; status?: string };
  run?: { status?: string };
  [key: string]: unknown;
}

type AdapterLogMessage = AdapterLogEvent & { sessions?: AdapterSessionInfo[] };

function AdapterLogEventRow({ event }: { event: AdapterLogEvent }) {
  const time = typeof event.timestamp === "number" ? new Date(event.timestamp) : null;
  const detail =
    event.frameStatus ??
    event.state ??
    event.reason ??
    event.error ??
    event.frameType ??
    event.node?.status ??
    event.run?.status ??
    event.node?.title;
  return (
    <details className={`adapter-log__event is-${eventTone(event)}`}>
      <summary>
        <span className="adapter-log__event-type">{event.type}</span>
        <span className="adapter-log__event-detail">{detail || "-"}</span>
        <span className="adapter-log__event-meta">
          {event.adapterId ?? event.workflowId ?? "adapter"} ·{" "}
          {time?.toLocaleTimeString() ?? "--:--:--"}
        </span>
      </summary>
      <pre>{JSON.stringify(event, null, 2)}</pre>
    </details>
  );
}

function eventTone(event: AdapterLogEvent): "success" | "error" | "waiting" | "running" {
  if (event.type.includes("failed") || event.error) return "error";
  if (event.type.includes("completed") || event.state === "completed") return "success";
  if (event.type.includes("waiting") || event.type.includes("approval")) return "waiting";
  return "running";
}
