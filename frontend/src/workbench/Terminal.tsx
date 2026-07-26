import { useEffect, useMemo, useRef, useState } from "react";
import { type AgentSessionApp, getProfiles, type ShellProfile } from "./api";
import { TerminalSession } from "./TerminalSession";

interface ProfilesState {
  os: "windows" | "macos" | "linux";
  profiles: ShellProfile[];
}

interface SessionEntry {
  localId: string;
  profile: ShellProfile;
  title: string;
  workspaceId: string | null;
  agentSession?: {
    app: AgentSessionApp;
    sessionId: string;
    workspaceId: string;
  };
}

export interface AgentTerminalLaunchRequest {
  key: number;
  app: AgentSessionApp;
  sessionId: string;
  title: string;
  workspaceId: string;
}

interface TerminalProps {
  workspaceId: string | null;
  launchRequest?: AgentTerminalLaunchRequest | null;
  onLaunchHandled?: (key: number) => void;
}

let SESSION_COUNTER = 0;

export function Terminal({ workspaceId, launchRequest = null, onLaunchHandled }: TerminalProps) {
  const [profilesState, setProfilesState] = useState<ProfilesState | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const handledLaunchRef = useRef<number | null>(null);
  const previousWorkspaceRef = useRef(workspaceId);

  // Load profile list once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getProfiles();
        if (cancelled) return;
        setProfilesState(p);
        if (p.profiles.length > 0 && !defaultProfileId) {
          setDefaultProfileId(p.profiles[0].id);
        }
      } catch (e) {
        if (!cancelled) {
          setProfilesError(`无法获取后端 shell 列表：${(e as Error).message}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultProfileId]);

  // Auto-spawn one session when the panel becomes usable
  useEffect(() => {
    if (!workspaceId || !profilesState || !defaultProfileId) return;
    if (sessions.length > 0) return;
    if (launchRequest && handledLaunchRef.current !== launchRequest.key) return;
    const profile = profilesState.profiles.find((p) => p.id === defaultProfileId);
    if (!profile) return;
    spawnSession(profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, profilesState, defaultProfileId, launchRequest, sessions.length]);

  useEffect(() => {
    if (!launchRequest || handledLaunchRef.current === launchRequest.key) return;
    if (!profilesState || !defaultProfileId) return;
    const profile = profilesState.profiles.find((p) => p.id === defaultProfileId);
    if (!profile) return;
    handledLaunchRef.current = launchRequest.key;
    spawnSession(profile, launchRequest);
    onLaunchHandled?.(launchRequest.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchRequest, profilesState, defaultProfileId, onLaunchHandled]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  // When workspace changes, drop all sessions (their effects will tear down)
  useEffect(() => {
    if (previousWorkspaceRef.current === workspaceId) return;
    previousWorkspaceRef.current = workspaceId;
    setSessions([]);
    setActiveId(null);
  }, [workspaceId]);

  const spawnSession = (profile: ShellProfile, agentLaunch?: AgentTerminalLaunchRequest) => {
    if (!workspaceId && !agentLaunch) return;
    SESSION_COUNTER += 1;
    const localId = `s_${SESSION_COUNTER}`;
    const entry: SessionEntry = {
      localId,
      profile,
      title: agentLaunch
        ? `${agentLaunch.app === "codex" ? "Codex" : "Claude"}: ${agentLaunch.title}`
        : `${profile.label} ${SESSION_COUNTER}`,
      workspaceId: agentLaunch ? null : workspaceId,
      agentSession: agentLaunch
        ? {
            app: agentLaunch.app,
            sessionId: agentLaunch.sessionId,
            workspaceId: agentLaunch.workspaceId,
          }
        : undefined,
    };
    setSessions((prev) => [...prev, entry]);
    setActiveId(localId);
    setDefaultProfileId(profile.id);
  };

  const closeSession = (localId: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.localId !== localId);
      if (activeId === localId) {
        const idx = prev.findIndex((s) => s.localId === localId);
        const fallback = next[idx] ?? next[idx - 1] ?? next[next.length - 1] ?? null;
        setActiveId(fallback ? fallback.localId : null);
      }
      return next;
    });
  };

  const activeProfile = useMemo(() => {
    const s = sessions.find((x) => x.localId === activeId);
    return s?.profile ?? null;
  }, [sessions, activeId]);

  const osLabel =
    profilesState?.os === "windows"
      ? "Windows"
      : profilesState?.os === "macos"
        ? "macOS"
        : profilesState?.os === "linux"
          ? "Linux"
          : "?";

  if (!workspaceId && sessions.length === 0 && !launchRequest) {
    return (
      <div className="terminal terminal--empty muted">
        请先选择工作区，终端会在该工作区根目录启动
      </div>
    );
  }

  return (
    <div className="terminal" ref={rootRef}>
      <div className="terminal__main">
        <div className="terminal__panes">
          {profilesError && <div className="terminal__error">{profilesError}</div>}
          {sessions.length === 0 && !profilesError && (
            <div className="terminal__placeholder muted">
              {profilesState?.profiles.length === 0
                ? "后端未探测到任何 shell"
                : "正在创建终端会话…"}
            </div>
          )}
          {sessions.map((s) => (
            <TerminalSession
              key={s.localId}
              workspaceId={s.workspaceId}
              profile={s.profile}
              agentSession={s.agentSession}
              active={s.localId === activeId}
              onClose={() => closeSession(s.localId)}
            />
          ))}
        </div>
        <div className="terminal__sidebar">
          <div className="terminal__sidebar-actions">
            <button
              className="icon-btn"
              title={activeProfile ? `新建 ${activeProfile.label} 终端` : "新建终端"}
              onClick={() => {
                const profile =
                  activeProfile ??
                  profilesState?.profiles.find((p) => p.id === defaultProfileId) ??
                  profilesState?.profiles[0];
                if (profile) spawnSession(profile);
              }}
              disabled={!profilesState || profilesState.profiles.length === 0}
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
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
            <button
              className="icon-btn"
              title="选择 profile 并新建"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={!profilesState || profilesState.profiles.length === 0}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M3 6l5 5 5-5z" />
              </svg>
            </button>
            {menuOpen && (
              <div className="terminal__menu">
                <div className="terminal__menu-header">新建终端（{osLabel}）</div>
                {(profilesState?.profiles ?? []).length === 0 && (
                  <div className="terminal__menu-item is-empty">后端未探测到可用 shell</div>
                )}
                {profilesState?.profiles.map((p) => (
                  <button
                    key={p.id}
                    className={`terminal__menu-item${p.id === defaultProfileId ? " is-active" : ""}`}
                    onClick={() => {
                      spawnSession(p);
                      setMenuOpen(false);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="terminal__sidebar-list">
            {sessions.map((s) => (
              <div
                key={s.localId}
                className={`terminal__sidebar-item${s.localId === activeId ? " is-active" : ""}`}
                onClick={() => setActiveId(s.localId)}
                title={s.title}
              >
                <span className="terminal__sidebar-icon">
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 4l4 4-4 4" />
                    <path d="M8 12h6" />
                  </svg>
                </span>
                <span className="terminal__sidebar-name">{s.title}</span>
                <button
                  className="terminal__sidebar-close"
                  title="关闭终端"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.localId);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
