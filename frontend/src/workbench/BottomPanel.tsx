import { lazy, Suspense, useEffect, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
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
          onClick={() => setTab("docs")}
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
          {tab === "terminal" && (
            <Terminal
              workspaceId={workspaceId}
              launchRequest={terminalLaunchRequest}
              onLaunchHandled={onTerminalLaunchHandled}
            />
          )}
          {tab === "log" && (
            <div className="muted" style={{ padding: "10px 16px" }}>
              {t("panel.logComingSoon")}
            </div>
          )}
          {tab === "docs" && (
            <PlanView
              workspaceId={workspaceId}
              refreshSignal={docsRefreshSignal}
              editorFontSize={editorFontSize}
              editorTabSize={editorTabSize}
              autoSave={editorAutoSave}
              onDocsChanged={onDocsChanged}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
