import { useEffect, useState } from "react";
import { PlanView } from "./PlanView";
import { type AgentTerminalLaunchRequest, Terminal } from "./Terminal";

type BottomTab = "terminal" | "log" | "plan";

interface BottomPanelProps {
  workspaceId: string | null;
  onClose: () => void;
  terminalLaunchRequest?: AgentTerminalLaunchRequest | null;
  onTerminalLaunchHandled?: (key: number) => void;
}

export function BottomPanel({
  workspaceId,
  onClose,
  terminalLaunchRequest = null,
  onTerminalLaunchHandled,
}: BottomPanelProps) {
  const [tab, setTab] = useState<BottomTab>("terminal");

  useEffect(() => {
    if (terminalLaunchRequest) setTab("terminal");
  }, [terminalLaunchRequest]);

  return (
    <div className="bottom-panel">
      <div className="bottom-panel__tabs">
        <div
          className={`bottom-panel__tab${tab === "terminal" ? " is-active" : ""}`}
          onClick={() => setTab("terminal")}
        >
          终端
        </div>
        <div
          className={`bottom-panel__tab${tab === "log" ? " is-active" : ""}`}
          onClick={() => setTab("log")}
        >
          日志
        </div>
        <div
          className={`bottom-panel__tab${tab === "plan" ? " is-active" : ""}`}
          onClick={() => setTab("plan")}
        >
          计划
        </div>
        <button
          className="icon-btn bottom-panel__close"
          title="关闭面板（终止所有终端）"
          onClick={onClose}
        >
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
        {tab === "terminal" && (
          <Terminal
            workspaceId={workspaceId}
            launchRequest={terminalLaunchRequest}
            onLaunchHandled={onTerminalLaunchHandled}
          />
        )}
        {tab === "log" && (
          <div className="muted" style={{ padding: "10px 16px" }}>
            任务执行日志将在后续阶段接入。
          </div>
        )}
        {tab === "plan" && <PlanView workspaceId={workspaceId} />}
      </div>
    </div>
  );
}
