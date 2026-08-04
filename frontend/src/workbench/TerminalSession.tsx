import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  type AgentSessionApp,
  createAgentSessionTerminal,
  createTerminal,
  killTerminal,
  openTerminalSocket,
  type ShellProfile,
  type TerminalCreateResp,
} from "./api";

interface TerminalSessionProps {
  workspaceId: string | null;
  profile: ShellProfile;
  agentSession?: {
    app: AgentSessionApp;
    sessionId: string;
    workspaceId: string;
  };
  active: boolean;
  onClose: () => void;
}

type Status = "connecting" | "open" | "closed";

export function TerminalSession({
  workspaceId,
  profile,
  agentSession,
  active,
  onClose,
}: TerminalSessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);

  // Mount xterm + spawn backend session. Lives until this component unmounts.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposeTerminal: (() => void) | null = null;
    const mountTimer = window.setTimeout(() => {
      const term = new XTerm({
        convertEol: false,
        cursorBlink: true,
        fontFamily: "Cascadia Mono, Consolas, Courier New, monospace",
        fontSize: 13,
        theme: {
          background: "#1f1f1f",
          foreground: "#cccccc",
          cursor: "#aeafad",
          selectionBackground: "#264f78",
        },
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      try {
        fit.fit();
      } catch {
        /* layout race */
      }
      xtermRef.current = term;
      fitRef.current = fit;
      if (activeRef.current) {
        try {
          fit.fit();
          term.focus();
        } catch {
          /* layout race */
        }
      }

      // Intercept Ctrl+Shift+C / Ctrl+Shift+V so the browser doesn't open
      // devtools and we route them to clipboard ourselves. xterm's default
      // for these chords is to ignore them, which lets the browser default
      // (devtools toggle) fire — we want copy/paste instead.
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        const isCopy =
          ev.ctrlKey && ev.shiftKey && !ev.altKey && (ev.code === "KeyC" || ev.key === "C");
        const isPaste =
          ev.ctrlKey && ev.shiftKey && !ev.altKey && (ev.code === "KeyV" || ev.key === "V");
        if (isCopy) {
          const sel = term.getSelection();
          if (sel) {
            void navigator.clipboard.writeText(sel).catch(() => undefined);
          }
          ev.preventDefault();
          ev.stopPropagation();
          return false;
        }
        if (isPaste) {
          void navigator.clipboard
            .readText()
            .then((text) => {
              const live = wsRef.current;
              if (live && live.readyState === WebSocket.OPEN && text) {
                live.send(JSON.stringify({ type: "input", data: text }));
              }
            })
            .catch(() => undefined);
          ev.preventDefault();
          ev.stopPropagation();
          return false;
        }
        return true;
      });

      let cancelled = false;
      let ws: WebSocket | null = null;

      term.writeln(`\x1b[2m[osheep] 连接到后端 PTY (${profile.label})…\x1b[0m`);

      (async () => {
        let session: TerminalCreateResp;
        try {
          session = agentSession
            ? await createAgentSessionTerminal({
                app: agentSession.app,
                sessionId: agentSession.sessionId,
                workspaceId: agentSession.workspaceId,
                shell: profile.id,
                cols: term.cols || 80,
                rows: term.rows || 24,
              })
            : await createTerminal({
                workspaceId: workspaceId as string,
                shell: profile.id,
                cols: term.cols || 80,
                rows: term.rows || 24,
              });
        } catch (e) {
          if (cancelled) return;
          setStatus("closed");
          setError(`创建终端失败：${(e as Error).message}`);
          return;
        }
        if (cancelled) {
          void killTerminal(session.id).catch(() => undefined);
          return;
        }
        sessionIdRef.current = session.id;
        ws = openTerminalSocket(session.wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) return;
          setStatus("open");
          try {
            ws?.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              }),
            );
          } catch {
            /* ignore */
          }
        };
        ws.onmessage = (ev) => {
          if (cancelled) return;
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "output" && typeof msg.data === "string") {
              term.write(msg.data);
            } else if (msg.type === "exit") {
              term.writeln(
                `\r\n\x1b[2m[osheep] 进程退出 code=${msg.code} signal=${msg.signal ?? "null"}\x1b[0m`,
              );
              setStatus("closed");
            } else if (msg.type === "error") {
              term.writeln(`\r\n\x1b[31m[osheep] ${msg.message}\x1b[0m`);
            } else if (msg.type === "ping") {
              ws?.send(JSON.stringify({ type: "pong" }));
            }
          } catch {
            /* ignore parse */
          }
        };
        ws.onclose = () => {
          if (cancelled) return;
          setStatus("closed");
        };
        ws.onerror = () => {
          if (cancelled) return;
          setError("WebSocket 错误");
        };
      })();

      const inputDisp = term.onData((data) => {
        const live = wsRef.current;
        if (live && live.readyState === WebSocket.OPEN) {
          live.send(JSON.stringify({ type: "input", data }));
        }
      });

      const resizeObs = new ResizeObserver(() => {
        try {
          fit.fit();
          const live = wsRef.current;
          if (live && live.readyState === WebSocket.OPEN) {
            live.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              }),
            );
          }
        } catch {
          /* layout race */
        }
      });
      resizeObs.observe(host);

      disposeTerminal = () => {
        cancelled = true;
        resizeObs.disconnect();
        inputDisp.dispose();
        const live = wsRef.current;
        if (live) {
          live.onmessage = null;
          live.onopen = null;
          live.onerror = null;
          live.onclose = null;
          if (live.readyState <= WebSocket.OPEN) live.close();
        }
        wsRef.current = null;
        try {
          term.dispose();
        } catch {
          /* already disposed */
        }
        const sid = sessionIdRef.current;
        sessionIdRef.current = null;
        if (sid) void killTerminal(sid).catch(() => undefined);
        xtermRef.current = null;
        fitRef.current = null;
      };
    }, 0);

    return () => {
      window.clearTimeout(mountTimer);
      disposeTerminal?.();
    };
  }, [workspaceId, profile, agentSession]);

  // When this session becomes visible, force a fit + focus.
  useEffect(() => {
    if (!active) return;
    const term = xtermRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    // Defer to next frame so layout settles before measuring.
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
        term.focus();
        const live = wsRef.current;
        if (live && live.readyState === WebSocket.OPEN) {
          live.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        }
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div className={`term-session${active ? " is-active" : " is-hidden"}`} data-status={status}>
      {error && <div className="term-session__error">{error}</div>}
      <div className="term-session__host" ref={hostRef} />
      {!active && status === "closed" && (
        <button className="term-session__overlay-btn" onClick={onClose} title="关闭已结束的会话">
          关闭
        </button>
      )}
    </div>
  );
}
