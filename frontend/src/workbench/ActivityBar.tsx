import type { ReactNode } from "react";

export type ViewId = "explorer" | "search" | "git";

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
  { id: "explorer", label: "资源管理器", icon: <FilesIcon /> },
  { id: "search", label: "搜索", icon: <SearchIcon /> },
  { id: "git", label: "源代码管理", icon: <GitIcon /> },
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
