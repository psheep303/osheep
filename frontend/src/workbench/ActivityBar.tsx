import type { ReactNode } from "react";
import { ClaudeLogo, OpenAILogo } from "./BrandIcons";

export type ViewId =
  | "workflow"
  | "template"
  | "explorer"
  | "search"
  | "git"
  | "claude-code"
  | "codex";

interface ActivityBarProps {
  activeView: ViewId;
  collapsed: boolean;
  onSelect: (id: ViewId) => void;
  onOpenSettings: () => void;
}

interface Item {
  id: ViewId;
  label: string;
  icon: ReactNode;
}

const ITEMS: Item[] = [
  { id: "workflow", label: "Workflow", icon: <WorkflowIcon /> },
  { id: "template", label: "Templates", icon: <TemplateIcon /> },
  { id: "explorer", label: "资源管理器", icon: <FilesIcon /> },
  { id: "search", label: "搜索", icon: <SearchIcon /> },
  { id: "git", label: "源代码管理", icon: <GitIcon /> },
  { id: "claude-code", label: "Claude Code", icon: <ClaudeLogo /> },
  { id: "codex", label: "Codex", icon: <OpenAILogo /> },
];

export function ActivityBar({ activeView, collapsed, onSelect, onOpenSettings }: ActivityBarProps) {
  return (
    <div className="activity-bar">
      <div className="activity-bar__group">
        {ITEMS.map((it) => {
          const active = it.id === activeView && !collapsed;
          return (
            <button
              key={it.id}
              className={"activity-bar__item" + (active ? " is-active" : "")}
              onClick={() => onSelect(it.id)}
              title={it.label}
              aria-label={it.label}
            >
              <span className="activity-bar__icon">{it.icon}</span>
            </button>
          );
        })}
      </div>
      <div className="activity-bar__group activity-bar__group--bottom">
        <button
          className="activity-bar__item"
          title="设置"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <span className="activity-bar__icon"><SettingsIcon /></span>
        </button>
      </div>
    </div>
  );
}

function WorkflowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <circle cx="12" cy="17" r="2.2" />
      <path d="M8.1 8.2 10.7 15" />
      <path d="M15.9 8.2 13.3 15" />
      <path d="M8.4 7h7.2" />
    </svg>
  );
}

function TemplateIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 4.5h9.5L19 9v10.5H5z" />
      <path d="M14.5 4.5V9H19" />
      <path d="M8 12h8M8 15h6" />
      <path d="M3 7.5v14h13" opacity=".65" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M14 3H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6l-2-3z" />
      <path d="M9 7h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-9" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="10.5" cy="10.5" r="6" />
      <line x1="20" y1="20" x2="15" y2="15" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="13" r="2.2" />
      <path d="M6 8.2v7.6" />
      <path d="M8 6h4a3 3 0 0 1 3 3v2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.1a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.1A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.1A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.07.41.42.7.83.7H21a2 2 0 1 1 0 4h-.1a1.65 1.65 0 0 0-1.5 1.3z" />
    </svg>
  );
}

export function CodexIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="currentColor"
      fillRule="evenodd"
    >
      <title>OpenAI</title>
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  );
}
