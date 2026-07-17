import { useState, type ReactNode } from "react";
import { AgentAdvancedSettingsView } from "./AgentAdvancedSettingsView";
import { AiSettingsView } from "./AiSettingsView";
import { ClaudePluginsView } from "./ClaudePluginsView";
import { CodexPluginsView } from "./CodexPluginsView";

interface AgentSection<T extends string> {
  id: T;
  label: string;
  hidden?: boolean;
}

type ClaudeCodeSection = "api-model" | "plugins" | "hooks" | "mcp" | "environment";
type CodexSection = "api-model" | "plugins" | "permissions" | "environment";

const CLAUDE_CODE_SECTIONS: AgentSection<ClaudeCodeSection>[] = [
  { id: "api-model", label: "API & Model" },
  { id: "plugins", label: "Plugins" },
  { id: "hooks", label: "Hooks", hidden: true },
  { id: "mcp", label: "MCP", hidden: true },
  { id: "environment", label: "Environment", hidden: true },
];

const CODEX_SECTIONS: AgentSection<CodexSection>[] = [
  { id: "api-model", label: "API & Model" },
  { id: "plugins", label: "Plugins" },
  { id: "permissions", label: "Permissions", hidden: true },
  { id: "environment", label: "Environment", hidden: true },
];

export function ClaudeCodeAgentView() {
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
      ) : section === "plugins" ? (
        <ClaudePluginsView />
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

export function CodexAgentView() {
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
      ) : section === "plugins" ? (
        <CodexPluginsView />
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
  return (
    <div className="agent-settings side-view">
      <div className="side-view__header agent-settings__header">
        <span className="side-view__title">{title}</span>
      </div>

      <div className="agent-settings__nav" role="tablist" aria-label={`${title} sections`}>
        {sections.filter((section) => !section.hidden).map((section) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            className={
              "agent-settings__nav-item" +
              (activeSection === section.id ? " is-active" : "")
            }
            aria-selected={activeSection === section.id}
            onClick={() => onSelect(section.id)}
          >
            <span>{section.label}</span>
          </button>
        ))}
      </div>

      <div className="agent-settings__body">{children}</div>
    </div>
  );
}
