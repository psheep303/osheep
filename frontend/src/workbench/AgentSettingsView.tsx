import { useState, type ReactNode } from "react";
import { AiSettingsView } from "./AiSettingsView";
import { ClaudePluginsView } from "./ClaudePluginsView";
import { CodexPluginsView } from "./CodexPluginsView";

interface AgentSection<T extends string> {
  id: T;
  label: string;
  future?: boolean;
}

type ClaudeCodeSection = "api-model" | "plugins" | "hooks" | "mcp" | "environment";
type CodexSection = "api-model" | "plugins" | "permissions" | "environment";

const CLAUDE_CODE_SECTIONS: AgentSection<ClaudeCodeSection>[] = [
  { id: "api-model", label: "API & Model" },
  { id: "plugins", label: "Plugins" },
  { id: "hooks", label: "Hooks", future: true },
  { id: "mcp", label: "MCP", future: true },
  { id: "environment", label: "Environment", future: true },
];

const CODEX_SECTIONS: AgentSection<CodexSection>[] = [
  { id: "api-model", label: "API & Model" },
  { id: "plugins", label: "Plugins" },
  { id: "permissions", label: "Permissions", future: true },
  { id: "environment", label: "Environment", future: true },
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
      ) : (
        <AgentPlaceholder title={sectionLabel(CLAUDE_CODE_SECTIONS, section)} />
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
      ) : (
        <AgentPlaceholder title={sectionLabel(CODEX_SECTIONS, section)} />
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
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            className={
              "agent-settings__nav-item" +
              (activeSection === section.id ? " is-active" : "")
            }
            aria-selected={activeSection === section.id}
            disabled={section.future}
            onClick={() => onSelect(section.id)}
          >
            <span>{section.label}</span>
            {section.future && <span className="agent-settings__future">未来</span>}
          </button>
        ))}
      </div>

      <div className="agent-settings__body">{children}</div>
    </div>
  );
}

function AgentPlaceholder({ title }: { title: string }) {
  return (
    <div className="agent-settings__placeholder">
      <div className="agent-settings__placeholder-title">{title}</div>
      <div className="agent-settings__placeholder-subtitle">即将可用</div>
    </div>
  );
}

function sectionLabel<T extends string>(sections: AgentSection<T>[], id: T): string {
  return sections.find((section) => section.id === id)?.label ?? id;
}
