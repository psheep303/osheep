import { lazy, type ReactNode, Suspense, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { AgentAdvancedSettingsView } from "./AgentAdvancedSettingsView";
import { AgentSessionsView } from "./AgentSessionsView";
import type { AgentSessionSummary } from "./api";
import { ClaudePluginsView } from "./ClaudePluginsView";
import { CodexPluginsView } from "./CodexPluginsView";
import { SkillsView } from "./SkillsView";

const AiSettingsView = lazy(() =>
  import("./AiSettingsView").then((module) => ({ default: module.AiSettingsView })),
);

interface AgentSection<T extends string> {
  id: T;
  label: string;
  hidden?: boolean;
}

type ClaudeCodeSection =
  | "api-model"
  | "sessions"
  | "plugins"
  | "skills"
  | "hooks"
  | "mcp"
  | "environment";
type CodexSection = "api-model" | "sessions" | "plugins" | "skills" | "permissions" | "environment";

const CLAUDE_CODE_SECTIONS: AgentSection<ClaudeCodeSection>[] = [
  { id: "api-model", label: "API & Model" },
  { id: "sessions", label: "Sessions" },
  { id: "plugins", label: "Plugins" },
  { id: "skills", label: "Skills" },
  { id: "hooks", label: "Hooks", hidden: true },
  { id: "mcp", label: "MCP", hidden: true },
  { id: "environment", label: "Environment", hidden: true },
];

const CODEX_SECTIONS: AgentSection<CodexSection>[] = [
  { id: "api-model", label: "API & Model" },
  { id: "sessions", label: "Sessions" },
  { id: "plugins", label: "Plugins" },
  { id: "skills", label: "Skills" },
  { id: "permissions", label: "Permissions", hidden: true },
  { id: "environment", label: "Environment", hidden: true },
];

interface AgentViewProps {
  workspaceId: string | null;
  onResumeSession: (session: AgentSessionSummary) => void;
}

export function ClaudeCodeAgentView(props: AgentViewProps) {
  const { workspaceId, onResumeSession } = props;
  const [section, setSection] = useState<ClaudeCodeSection>("api-model");

  return (
    <AgentShell
      title="Claude Code"
      sections={CLAUDE_CODE_SECTIONS}
      activeSection={section}
      onSelect={setSection}
    >
      {section === "api-model" ? (
        <AiSettingsView app="claude" />
      ) : section === "sessions" ? (
        <AgentSessionsView
          key={workspaceId ?? "no-workspace"}
          app="claude"
          workspaceId={workspaceId}
          onResume={onResumeSession}
        />
      ) : section === "plugins" ? (
        <ClaudePluginsView />
      ) : section === "skills" ? (
        <SkillsView agent="claude" />
      ) : section === "hooks" ? (
        <AgentAdvancedSettingsView app="claude" section="hooks" />
      ) : section === "mcp" ? (
        <AgentAdvancedSettingsView app="claude" section="mcp" />
      ) : (
        <AgentAdvancedSettingsView app="claude" section="environment" />
      )}
    </AgentShell>
  );
}

export function CodexAgentView(props: AgentViewProps) {
  const { workspaceId, onResumeSession } = props;
  const [section, setSection] = useState<CodexSection>("api-model");

  return (
    <AgentShell
      title="Codex"
      sections={CODEX_SECTIONS}
      activeSection={section}
      onSelect={setSection}
    >
      {section === "api-model" ? (
        <AiSettingsView app="codex" />
      ) : section === "sessions" ? (
        <AgentSessionsView
          key={workspaceId ?? "no-workspace"}
          app="codex"
          workspaceId={workspaceId}
          onResume={onResumeSession}
        />
      ) : section === "plugins" ? (
        <CodexPluginsView />
      ) : section === "skills" ? (
        <SkillsView agent="codex" />
      ) : section === "permissions" ? (
        <AgentAdvancedSettingsView app="codex" section="permissions" />
      ) : (
        <AgentAdvancedSettingsView app="codex" section="environment" />
      )}
    </AgentShell>
  );
}

function AgentShell<T extends string>({
  title,
  sections,
  activeSection,
  onSelect,
  children,
}: {
  title: string;
  sections: AgentSection<T>[];
  activeSection: T;
  onSelect: (section: T) => void;
  children: ReactNode;
}) {
  const { t } = useUiPreferences();
  return (
    <div className="agent-settings side-view">
      <div className="side-view__header agent-settings__header">
        <span className="side-view__title">{title}</span>
      </div>

      <div className="agent-settings__nav" role="tablist" aria-label={`${title} sections`}>
        {sections
          .filter((section) => !section.hidden)
          .map((section) => (
            <button
              key={section.id}
              type="button"
              role="tab"
              className={`agent-settings__nav-item${activeSection === section.id ? " is-active" : ""}`}
              aria-selected={activeSection === section.id}
              onClick={() => onSelect(section.id)}
            >
              <span>{section.id === "skills" ? t("skills.title") : section.label}</span>
            </button>
          ))}
      </div>

      <div className="agent-settings__body">
        <Suspense fallback={<div className="tab-loading-fallback" />}>{children}</Suspense>
      </div>
    </div>
  );
}
