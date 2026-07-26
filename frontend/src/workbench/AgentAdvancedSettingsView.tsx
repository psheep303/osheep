import { useEffect, useMemo, useState } from "react";
import {
  type AiSettingsApp,
  type AiSettingsProvider,
  type AiSettingsSnapshot,
  getAiSettings,
  importAiLiveProvider,
  saveAiProvider,
} from "./api";

type ClaudeAdvancedSection = "hooks" | "mcp" | "environment";
type CodexAdvancedSection = "permissions" | "environment";

interface AgentAdvancedSettingsViewProps {
  app: AiSettingsApp;
  section: ClaudeAdvancedSection | CodexAdvancedSection;
}

interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}

type JsonRecord = Record<string, unknown>;

const CODEX_APPROVAL_OPTIONS = [
  { value: "untrusted", label: "Untrusted", hint: "Ask before commands outside the trusted set." },
  {
    value: "on-request",
    label: "On request",
    hint: "Let the agent decide when approval is needed.",
  },
  { value: "never", label: "Never", hint: "Do not prompt; failures go back to the agent." },
];

const CODEX_SANDBOX_OPTIONS = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Danger full access" },
];

const CODEX_ENV_INHERIT_OPTIONS = [
  { value: "all", label: "All" },
  { value: "core", label: "Core" },
  { value: "none", label: "None" },
];

export function AgentAdvancedSettingsView({ app, section }: AgentAdvancedSettingsViewProps) {
  const [snapshot, setSnapshot] = useState<AiSettingsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState("{}");
  const [claudeEnvRows, setClaudeEnvRows] = useState<KeyValueRow[]>([]);
  const [configText, setConfigText] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState("on-request");
  const [sandboxMode, setSandboxMode] = useState("workspace-write");
  const [sandboxPermissionsText, setSandboxPermissionsText] = useState("");
  const [envInherit, setEnvInherit] = useState("all");
  const [envExcludeText, setEnvExcludeText] = useState("");
  const [codexEnvRows, setCodexEnvRows] = useState<KeyValueRow[]>([]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeProvider = useMemo(() => currentProvider(snapshot, app), [snapshot, app]);

  const provider = useMemo(() => activeProvider ?? defaultProvider(app), [activeProvider, app]);

  const pathText =
    app === "claude"
      ? (snapshot?.paths.claude.settings ?? "~/.claude/settings.json")
      : (snapshot?.paths.codex.config ?? "~/.codex/config.toml");

  useEffect(() => {
    if (!snapshot) return;
    resetDraft(provider);
  }, [snapshot, provider, resetDraft]);

  async function refresh() {
    await run(async () => {
      setSnapshot(await getAiSettings());
    }, false);
  }

  async function run(task: () => Promise<void>, done = true) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await task();
      if (done) {
        setMessage("Saved and applied to live config.");
        window.setTimeout(() => setMessage(null), 3000);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function resetDraft(nextProvider: AiSettingsProvider) {
    if (app === "claude") {
      const settings = asRecord(nextProvider.settingsConfig) ?? {};
      if (section === "hooks") {
        setJsonText(prettyJson(settings.hooks ?? {}));
      } else if (section === "mcp") {
        setJsonText(prettyJson(settings.mcpServers ?? {}));
      } else {
        setClaudeEnvRows(rowsFromRecord(asRecord(settings.env) ?? {}));
      }
      return;
    }

    const settings = asRecord(nextProvider.settingsConfig) ?? {};
    const nextConfigText = typeof settings.config === "string" ? settings.config : "";
    setConfigText(nextConfigText);
    if (section === "permissions") {
      setApprovalPolicy(
        extractTomlTopLevelString(nextConfigText, "approval_policy") || "on-request",
      );
      setSandboxMode(
        extractTomlTopLevelString(nextConfigText, "sandbox_mode") || "workspace-write",
      );
      setSandboxPermissionsText(
        extractTomlTopLevelArray(nextConfigText, "sandbox_permissions").join("\n"),
      );
    } else {
      setEnvInherit(
        extractTomlSectionString(nextConfigText, "shell_environment_policy", "inherit") || "all",
      );
      setEnvExcludeText(
        extractTomlSectionArray(nextConfigText, "shell_environment_policy", "exclude").join("\n"),
      );
      setCodexEnvRows(
        rowsFromRecord(extractTomlSectionStringMap(nextConfigText, "shell_environment_policy.set")),
      );
    }
  }

  function importLive() {
    void run(async () => {
      setSnapshot(await importAiLiveProvider(app));
    });
  }

  function save() {
    void run(async () => {
      const nextProvider = buildProvider();
      const originalId = activeProvider ? activeProvider.id : undefined;
      setSnapshot(await saveAiProvider(app, nextProvider, originalId, true));
    });
  }

  function buildProvider(): AiSettingsProvider {
    const settings = cloneRecord(asRecord(provider.settingsConfig) ?? {});
    if (app === "claude") {
      if (section === "hooks") {
        settings.hooks = parseJsonObject(jsonText, "Hooks JSON");
      } else if (section === "mcp") {
        settings.mcpServers = parseJsonObject(jsonText, "MCP servers JSON");
      } else {
        settings.env = recordFromRows(claudeEnvRows, "Environment variable");
      }
      return { ...provider, settingsConfig: settings };
    }

    const codexSettings = cloneRecord(settings);
    codexSettings.auth = asRecord(codexSettings.auth) ?? { OPENAI_API_KEY: "" };
    codexSettings.config = buildCodexConfigText();
    return { ...provider, settingsConfig: codexSettings };
  }

  function buildCodexConfigText(): string {
    if (section === "permissions") {
      let next = configText;
      next = setTomlTopLevelString(next, "approval_policy", approvalPolicy);
      next = setTomlTopLevelString(next, "sandbox_mode", sandboxMode);
      next = setTomlTopLevelArray(
        next,
        "sandbox_permissions",
        listFromText(sandboxPermissionsText),
      );
      return next;
    }

    let next = configText;
    next = setTomlSectionString(next, "shell_environment_policy", "inherit", envInherit);
    next = setTomlSectionArray(
      next,
      "shell_environment_policy",
      "exclude",
      listFromText(envExcludeText),
    );
    next = setTomlSectionStringMap(
      next,
      "shell_environment_policy.set",
      recordFromRows(codexEnvRows, "Environment variable"),
    );
    return next;
  }

  function updateApprovalPolicy(value: string) {
    setApprovalPolicy(value);
    setConfigText((current) => setTomlTopLevelString(current, "approval_policy", value));
  }

  function updateSandboxMode(value: string) {
    setSandboxMode(value);
    setConfigText((current) => setTomlTopLevelString(current, "sandbox_mode", value));
  }

  function updateSandboxPermissions(value: string) {
    setSandboxPermissionsText(value);
    setConfigText((current) =>
      setTomlTopLevelArray(current, "sandbox_permissions", listFromText(value)),
    );
  }

  function updateEnvInherit(value: string) {
    setEnvInherit(value);
    setConfigText((current) =>
      setTomlSectionString(current, "shell_environment_policy", "inherit", value),
    );
  }

  function updateEnvExclude(value: string) {
    setEnvExcludeText(value);
    setConfigText((current) =>
      setTomlSectionArray(current, "shell_environment_policy", "exclude", listFromText(value)),
    );
  }

  function updateCodexEnvRows(rows: KeyValueRow[]) {
    setCodexEnvRows(rows);
    setConfigText((current) =>
      setTomlSectionStringMap(
        current,
        "shell_environment_policy.set",
        recordFromRows(rows, "Environment variable"),
      ),
    );
  }

  function updateConfigText(value: string) {
    setConfigText(value);
    if (section === "permissions") {
      setApprovalPolicy(extractTomlTopLevelString(value, "approval_policy") || approvalPolicy);
      setSandboxMode(extractTomlTopLevelString(value, "sandbox_mode") || sandboxMode);
      setSandboxPermissionsText(extractTomlTopLevelArray(value, "sandbox_permissions").join("\n"));
    } else {
      setEnvInherit(
        extractTomlSectionString(value, "shell_environment_policy", "inherit") || envInherit,
      );
      setEnvExcludeText(
        extractTomlSectionArray(value, "shell_environment_policy", "exclude").join("\n"),
      );
      setCodexEnvRows(
        rowsFromRecord(extractTomlSectionStringMap(value, "shell_environment_policy.set")),
      );
    }
  }

  return (
    <div className="agent-config side-view">
      <div className="side-view__header agent-config__header">
        <span className="side-view__title">{titleFor(app, section)}</span>
        <button className="icon-btn" title="Refresh" onClick={() => void refresh()} disabled={busy}>
          <RefreshIcon />
        </button>
      </div>

      <div className="agent-config__path" title={pathText}>
        {pathText}
      </div>

      <div className="agent-config__toolbar">
        <button className="primary-btn" onClick={save} disabled={busy || !snapshot}>
          Save
        </button>
        <button className="tb-btn" onClick={importLive} disabled={busy}>
          Import live
        </button>
      </div>

      {snapshot && (
        <div className="agent-config__current" title={provider.id}>
          Provider: {provider.name}
          {!activeProvider && " (new)"}
        </div>
      )}

      {error && <div className="agent-config__banner agent-config__banner--error">{error}</div>}
      {message && (
        <div className="agent-config__banner agent-config__banner--success">{message}</div>
      )}

      <div className="agent-config__body">
        {!snapshot ? (
          <div className="agent-config__empty">Loading...</div>
        ) : app === "claude" ? (
          renderClaudeSection()
        ) : section === "permissions" ? (
          renderCodexPermissions()
        ) : (
          renderCodexEnvironment()
        )}
      </div>
    </div>
  );

  function renderClaudeSection() {
    if (section === "environment") {
      return (
        <>
          <SectionTitle title="Environment variables" />
          <KeyValueEditor
            rows={claudeEnvRows}
            onChange={setClaudeEnvRows}
            keyPlaceholder="ANTHROPIC_LOG"
            valuePlaceholder="debug"
          />
        </>
      );
    }

    return (
      <>
        <SectionTitle title={section === "hooks" ? "Hooks JSON" : "MCP servers JSON"} />
        <textarea
          className="agent-config__textarea"
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          spellCheck={false}
        />
      </>
    );
  }

  function renderCodexPermissions() {
    return (
      <>
        <SectionTitle title="Permission defaults" />
        <Field label="Approval policy">
          <select
            className="settings-view__input agent-config__input"
            value={approvalPolicy}
            onChange={(e) => updateApprovalPolicy(e.target.value)}
          >
            {CODEX_APPROVAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="agent-config__hint">
          {CODEX_APPROVAL_OPTIONS.find((option) => option.value === approvalPolicy)?.hint}
        </div>
        <Field label="Sandbox mode">
          <select
            className="settings-view__input agent-config__input"
            value={sandboxMode}
            onChange={(e) => updateSandboxMode(e.target.value)}
          >
            {CODEX_SANDBOX_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sandbox permissions">
          <textarea
            className="agent-config__textarea agent-config__textarea--short"
            value={sandboxPermissionsText}
            onChange={(e) => updateSandboxPermissions(e.target.value)}
            placeholder="disk-full-read-access"
            spellCheck={false}
          />
        </Field>
        <RawTomlEditor value={configText} onChange={updateConfigText} />
      </>
    );
  }

  function renderCodexEnvironment() {
    return (
      <>
        <SectionTitle title="Shell environment policy" />
        <Field label="Inherit">
          <select
            className="settings-view__input agent-config__input"
            value={envInherit}
            onChange={(e) => updateEnvInherit(e.target.value)}
          >
            {CODEX_ENV_INHERIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Exclude variables">
          <textarea
            className="agent-config__textarea agent-config__textarea--short"
            value={envExcludeText}
            onChange={(e) => updateEnvExclude(e.target.value)}
            placeholder="OPENAI_API_KEY"
            spellCheck={false}
          />
        </Field>
        <SectionTitle title="Set variables" />
        <KeyValueEditor
          rows={codexEnvRows}
          onChange={updateCodexEnvRows}
          keyPlaceholder="RUST_LOG"
          valuePlaceholder="info"
        />
        <RawTomlEditor value={configText} onChange={updateConfigText} />
      </>
    );
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="agent-config__field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <div className="agent-config__section-title">{title}</div>;
}

function RawTomlEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <>
      <SectionTitle title="config.toml" />
      <textarea
        className="agent-config__textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </>
  );
}

function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  function update(index: number, patch: Partial<KeyValueRow>) {
    onChange(rows.map((row, current) => (current === index ? { ...row, ...patch } : row)));
  }

  function remove(index: number) {
    onChange(rows.filter((_, current) => current !== index));
  }

  function add() {
    onChange([...rows, { id: `row-${Date.now()}-${rows.length}`, key: "", value: "" }]);
  }

  return (
    <div className="agent-config__kv">
      {rows.length === 0 && (
        <div className="agent-config__empty agent-config__empty--compact">No entries</div>
      )}
      {rows.map((row, index) => (
        <div className="agent-config__kv-row" key={row.id}>
          <input
            className="settings-view__input agent-config__input"
            value={row.key}
            onChange={(e) => update(index, { key: e.target.value })}
            placeholder={keyPlaceholder}
            spellCheck={false}
          />
          <input
            className="settings-view__input agent-config__input"
            value={row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            placeholder={valuePlaceholder}
            spellCheck={false}
          />
          <button className="tb-btn agent-config__small-btn" onClick={() => remove(index)}>
            Remove
          </button>
        </div>
      ))}
      <button className="tb-btn" onClick={add}>
        Add
      </button>
    </div>
  );
}

function currentProvider(
  snapshot: AiSettingsSnapshot | null,
  app: AiSettingsApp,
): AiSettingsProvider | null {
  const manager = snapshot?.state.apps[app];
  if (!manager) return null;
  return manager.providers[manager.current] ?? null;
}

function defaultProvider(app: AiSettingsApp): AiSettingsProvider {
  return {
    id: "default",
    name: app === "claude" ? "Claude live" : "Codex live",
    category: "custom",
    createdAt: Date.now(),
    settingsConfig: app === "claude" ? { env: {} } : { auth: { OPENAI_API_KEY: "" }, config: "" },
  };
}

function titleFor(app: AiSettingsApp, section: AgentAdvancedSettingsViewProps["section"]): string {
  if (section === "hooks") return "Hooks";
  if (section === "mcp") return "MCP";
  if (section === "permissions") return "Permissions";
  return app === "claude" ? "Environment" : "Environment";
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJsonObject(text: string, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
  }
  const obj = asRecord(parsed);
  if (!obj) throw new Error(`${label} must be a JSON object`);
  return obj;
}

function rowsFromRecord(record: JsonRecord): KeyValueRow[] {
  return Object.entries(record).map(([key, value], index) => ({
    id: `${key}-${index}`,
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

function recordFromRows(rows: KeyValueRow[], label: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (!key) throw new Error(`${label} name is required`);
    record[key] = row.value;
  }
  return record;
}

function listFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractTomlTopLevelString(text: string, field: string): string {
  const lines = topLevelLines(text);
  return extractTomlStringFromLines(lines, field);
}

function extractTomlTopLevelArray(text: string, field: string): string[] {
  const lines = topLevelLines(text);
  return extractTomlStringArrayFromLines(lines, field);
}

function extractTomlSectionString(text: string, section: string, field: string): string {
  return extractTomlStringFromLines(sectionLines(text, section), field);
}

function extractTomlSectionArray(text: string, section: string, field: string): string[] {
  return extractTomlStringArrayFromLines(sectionLines(text, section), field);
}

function extractTomlSectionStringMap(text: string, section: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of sectionLines(text, section)) {
    const match = line.match(
      /^\s*([A-Za-z0-9_.-]+|"((?:\\.|[^"\\])*)")\s*=\s*"((?:\\.|[^"\\])*)"\s*$/,
    );
    if (!match) continue;
    const key = match[2] ? unescapeTomlString(match[2]) : (match[1] ?? "");
    if (key) record[key] = unescapeTomlString(match[3] ?? "");
  }
  return record;
}

function extractTomlStringFromLines(lines: string[], field: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, "m");
  const match = lines.join("\n").match(pattern);
  return match?.[1] ? unescapeTomlString(match[1]) : "";
}

function extractTomlStringArrayFromLines(lines: string[], field: string): string[] {
  const pattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=\\s*\\[([^\\]]*)\\]`, "m");
  const match = lines.join("\n").match(pattern);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((item) =>
    unescapeTomlString(item[1] ?? ""),
  );
}

function topLevelLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line) => /^\s*\[/.test(line));
  return end < 0 ? lines : lines.slice(0, end);
}

function sectionLines(text: string, section: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = findSectionStart(lines, section);
  if (start < 0) return [];
  const end = findSectionEnd(lines, start);
  return lines.slice(start + 1, end);
}

function setTomlTopLevelString(text: string, field: string, value: string): string {
  return setTomlTopLevelLine(text, field, `${field} = "${escapeTomlString(value)}"`);
}

function setTomlTopLevelArray(text: string, field: string, values: string[]): string {
  if (values.length === 0) return removeTomlTopLevelField(text, field);
  const array = values.map((value) => `"${escapeTomlString(value)}"`).join(", ");
  return setTomlTopLevelLine(text, field, `${field} = [${array}]`);
}

function setTomlTopLevelLine(text: string, field: string, line: string): string {
  const trimmed = trimTrailingBlankLines(text);
  if (!trimmed) return line;
  const lines = trimmed.split(/\r?\n/);
  const fieldPattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=`);
  let insertAt = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      insertAt = index;
      break;
    }
    if (fieldPattern.test(lines[index] ?? "")) {
      lines[index] = line;
      return lines.join("\n");
    }
  }
  lines.splice(insertAt, 0, line);
  return cleanTomlSpacing(lines.join("\n"));
}

function removeTomlTopLevelField(text: string, field: string): string {
  const fieldPattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=`);
  return text
    .split(/\r?\n/)
    .filter((line, index, lines) => {
      const beforeSection = lines.slice(0, index).every((candidate) => !/^\s*\[/.test(candidate));
      return !(beforeSection && fieldPattern.test(line));
    })
    .join("\n");
}

function setTomlSectionString(text: string, section: string, field: string, value: string): string {
  return setTomlSectionLine(text, section, field, `${field} = "${escapeTomlString(value)}"`);
}

function setTomlSectionArray(
  text: string,
  section: string,
  field: string,
  values: string[],
): string {
  if (values.length === 0) return removeTomlSectionField(text, section, field);
  const array = values.map((value) => `"${escapeTomlString(value)}"`).join(", ");
  return setTomlSectionLine(text, section, field, `${field} = [${array}]`);
}

function setTomlSectionLine(text: string, section: string, field: string, line: string): string {
  const header = `[${section}]`;
  const trimmed = trimTrailingBlankLines(text);
  if (!trimmed) return `${header}\n${line}`;
  const lines = trimmed.split(/\r?\n/);
  const start = findSectionStart(lines, section);
  if (start < 0) return cleanTomlSpacing(`${trimmed}\n\n${header}\n${line}`);
  const end = findSectionEnd(lines, start);
  const fieldPattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=`);
  for (let index = start + 1; index < end; index += 1) {
    if (fieldPattern.test(lines[index] ?? "")) {
      lines[index] = line;
      return lines.join("\n");
    }
  }
  lines.splice(end, 0, line);
  return lines.join("\n");
}

function removeTomlSectionField(text: string, section: string, field: string): string {
  const lines = text.split(/\r?\n/);
  const start = findSectionStart(lines, section);
  if (start < 0) return text;
  const end = findSectionEnd(lines, start);
  const fieldPattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=`);
  return lines
    .filter((line, index) => index <= start || index >= end || !fieldPattern.test(line))
    .join("\n");
}

function setTomlSectionStringMap(
  text: string,
  section: string,
  values: Record<string, string>,
): string {
  const withoutSection = removeTomlSection(removeTomlSectionInlineMap(text, section), section);
  const entries = Object.entries(values);
  if (entries.length === 0) return withoutSection;
  const body = entries
    .map(([key, value]) => `${tomlKey(key)} = "${escapeTomlString(value)}"`)
    .join("\n");
  const prefix = trimTrailingBlankLines(withoutSection);
  return cleanTomlSpacing(`${prefix}${prefix ? "\n\n" : ""}[${section}]\n${body}`);
}

function removeTomlSectionInlineMap(text: string, section: string): string {
  const parts = section.split(".");
  if (parts.length < 2) return text;
  const parent = parts.slice(0, -1).join(".");
  const field = parts[parts.length - 1] ?? "";
  return removeTomlSectionField(text, parent, field);
}

function removeTomlSection(text: string, section: string): string {
  const lines = text.split(/\r?\n/);
  const start = findSectionStart(lines, section);
  if (start < 0) return text;
  const end = findSectionEnd(lines, start);
  lines.splice(start, end - start);
  return cleanTomlSpacing(lines.join("\n"));
}

function findSectionStart(lines: string[], section: string): number {
  const header = `[${section}]`;
  const quotedHeader = `[${section
    .split(".")
    .map((part) => tomlKey(part))
    .join(".")}]`;
  return lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === header || trimmed === quotedHeader;
  });
}

function findSectionEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) return index;
  }
  return lines.length;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `"${escapeTomlString(value)}"`;
}

function trimTrailingBlankLines(text: string): string {
  return text.replace(/\s+$/g, "");
}

function cleanTomlSpacing(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function unescapeTomlString(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 3v4H9" />
      <path d="M3 13V9h4" />
      <path d="M12.2 6A4.5 4.5 0 0 0 4.5 4.8L3 6" />
      <path d="M3.8 10A4.5 4.5 0 0 0 11.5 11.2L13 10" />
    </svg>
  );
}
