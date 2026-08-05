import { useEffect, useMemo, useState } from "react";
import {
  type AiSettingsApp,
  type AiSettingsProvider,
  type AiSettingsSnapshot,
  deleteAiSettingsProvider,
  getAiSettings,
  importAiLiveProvider,
  saveAiProvider,
  switchAiSettingsProvider,
} from "./api";

interface ProviderCardProps {
  provider: AiSettingsProvider;
  isCurrent: boolean;
  onClick: () => void;
  onSwitch: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function ProviderCard({
  provider,
  isCurrent,
  onClick,
  onSwitch,
  onDelete,
  onDuplicate,
}: ProviderCardProps) {
  const getIcon = (name: string) => {
    const initial = name.charAt(0).toUpperCase();
    const colors = [
      "#f59e0b",
      "#10b981",
      "#3b82f6",
      "#8b5cf6",
      "#ec4899",
      "#ef4444",
      "#06b6d4",
      "#84cc16",
    ];
    const bgColor = provider.iconColor || colors[name.charCodeAt(0) % colors.length];
    return (
      <div className="ai-settings__icon" style={{ backgroundColor: bgColor }}>
        {initial}
      </div>
    );
  };

  const getUrl = () => {
    if (provider.notes?.trim()) return provider.notes;
    if (provider.websiteUrl) return provider.websiteUrl;
    const config = provider.settingsConfig as Record<string, any>;
    return config?.env?.ANTHROPIC_BASE_URL || "";
  };

  const url = getUrl();

  return (
    <div className={`ai-settings__card ${isCurrent ? "is-current" : ""}`}>
      <div className="ai-settings__card-gradient" />
      <button type="button" className="ai-settings__card-main" onClick={onClick}>
        {getIcon(provider.name)}
        <div className="ai-settings__card-info">
          <div className="ai-settings__card-header">
            <h3 className="ai-settings__card-title">{provider.name}</h3>
            {provider.category === "official" && (
              <span className="ai-settings__badge ai-settings__badge--gray">不支持路由</span>
            )}
            {isCurrent && (
              <span className="ai-settings__badge ai-settings__badge--green">当前</span>
            )}
          </div>
          {url && <div className="ai-settings__card-url">{url}</div>}
        </div>
      </button>
      <div className="ai-settings__card-actions">
        <button
          className="ai-settings__action-btn"
          onClick={(e) => {
            e.stopPropagation();
            onSwitch();
          }}
          disabled={isCurrent}
          title={isCurrent ? "当前已启用" : "启用"}
        >
          启用
        </button>
        <button
          className="ai-settings__icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
          title="复制"
        >
          <CopyIcon />
        </button>
        <button
          className="ai-settings__icon-btn ai-settings__icon-btn--danger"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          disabled={isCurrent}
          title={isCurrent ? "无法删除当前使用的 provider" : "删除"}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

interface ClaudeFormData {
  baseUrl: string;
  apiKey: string;
  model: string;
  sonnetModel: string;
  opusModel: string;
  haikuModel: string;
}

interface CodexFormData {
  apiKey: string;
  baseUrl: string;
  model: string;
  modelProvider: string;
  wireApi: string;
}

interface ProviderDetailProps {
  app: AiSettingsApp;
  provider: AiSettingsProvider | null;
  onSave: (provider: AiSettingsProvider) => void;
  busy: boolean;
  error: string | null;
}

function ProviderDetail({ app, provider, onSave, busy, error }: ProviderDetailProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("custom");
  const [claudeSettingsText, setClaudeSettingsText] = useState(prettyJson(defaultClaudeSettings()));
  const [codexAuthText, setCodexAuthText] = useState(prettyJson(defaultCodexAuth()));
  const [codexConfigText, setCodexConfigText] = useState(defaultCodexConfig());

  const [claudeForm, setClaudeForm] = useState<ClaudeFormData>(emptyClaudeForm());
  const [codexForm, setCodexForm] = useState<CodexFormData>(emptyCodexForm());

  const [formError, setFormError] = useState<string | null>(null);
  const isNew = !provider;

  useEffect(() => {
    if (provider) {
      setId(provider.id);
      setName(provider.name);
      setCategory(provider.category || "custom");

      if (app === "claude") {
        const settingsText = prettyJson(provider.settingsConfig ?? defaultClaudeSettings());
        setClaudeSettingsText(settingsText);
        setClaudeForm(claudeFormFromSettingsText(settingsText) ?? emptyClaudeForm());
      } else {
        const settings = asRecord(provider.settingsConfig);
        const auth = asRecord(settings?.auth) ?? defaultCodexAuth();
        const configText =
          typeof settings?.config === "string" ? settings.config : defaultCodexConfig();
        const authText = prettyJson(auth);
        setCodexAuthText(authText);
        setCodexConfigText(configText);
        setCodexForm(codexFormFromTexts(authText, configText));
      }
      setFormError(null);
    } else {
      setId("");
      setName("");
      setCategory("custom");
      const settingsText = prettyJson(defaultClaudeSettings());
      const authText = prettyJson(defaultCodexAuth());
      const configText = defaultCodexConfig();
      setClaudeSettingsText(settingsText);
      setCodexAuthText(authText);
      setCodexConfigText(configText);
      setClaudeForm(emptyClaudeForm());
      setCodexForm(codexFormFromTexts(authText, configText));
      setFormError(null);
    }
  }, [app, provider]);

  const handleBack = () => {
    handleSave();
  };

  const buildProvider = (): AiSettingsProvider => {
    if (!id.trim()) {
      throw new Error("ID 不能为空");
    }

    let settingsConfig: any;

    if (app === "claude") {
      settingsConfig = parseJsonObject(claudeSettingsText, "settings.json");
    } else {
      settingsConfig = {
        auth: parseJsonObject(codexAuthText, "auth.json"),
        config: codexConfigText,
      };
    }

    return {
      ...(provider ?? {}),
      id: id.trim(),
      name: name.trim() || id.trim(),
      category: category || "custom",
      createdAt: provider?.createdAt ?? Date.now(),
      settingsConfig,
    };
  };

  const handleSave = () => {
    try {
      setFormError(null);
      onSave(buildProvider());
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  const updateClaudeField = (field: keyof ClaudeFormData, value: string) => {
    const next = { ...claudeForm, [field]: value };
    setClaudeForm(next);
    setClaudeSettingsText((current) => updateClaudeSettingsText(current, next));
  };

  const updateCodexAuthField = (value: string) => {
    const next = { ...codexForm, apiKey: value };
    setCodexForm(next);
    setCodexAuthText((current) => updateJsonTextField(current, "OPENAI_API_KEY", value));
  };

  const updateCodexConfigField = (field: keyof Omit<CodexFormData, "apiKey">, value: string) => {
    const next = { ...codexForm, [field]: value };
    setCodexForm(next);
    setCodexConfigText((current) => updateCodexConfigText(current, next, name || id));
  };

  const handleClaudeSettingsChange = (value: string) => {
    setClaudeSettingsText(value);
    const next = claudeFormFromSettingsText(value);
    if (next) setClaudeForm(next);
  };

  const handleCodexAuthChange = (value: string) => {
    setCodexAuthText(value);
    setCodexForm(codexFormFromTexts(value, codexConfigText));
  };

  const handleCodexConfigChange = (value: string) => {
    setCodexConfigText(value);
    setCodexForm(codexFormFromTexts(codexAuthText, value));
  };

  return (
    <div className="ai-settings__detail">
      <div className="ai-settings__detail-header">
        <button className="ai-settings__back-btn" onClick={handleBack} disabled={busy}>
          <BackIcon />
        </button>
        <h2 className="ai-settings__detail-title">
          {isNew ? "新建 Provider" : (provider?.name ?? name)}
        </h2>
      </div>

      <div className="ai-settings__detail-content">
        {(formError || error) && (
          <div className="ai-settings__banner ai-settings__banner--error">{formError || error}</div>
        )}

        <div className="ai-settings__section">
          <h3 className="ai-settings__section-title">基本信息</h3>

          <Field label="ID" required>
            <input
              className="settings-view__input ai-settings__input"
              value={id}
              onChange={(e) => setId(e.target.value)}
              disabled={!isNew}
              placeholder="例如：my-provider"
            />
          </Field>

          <Field label="名称" required>
            <input
              className="settings-view__input ai-settings__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：我的 Claude 中转"
            />
          </Field>

          <Field label="类型">
            <select
              className="settings-view__input ai-settings__input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="custom">第三方/中转</option>
              <option value="official">官方</option>
            </select>
          </Field>
        </div>

        <div className="ai-settings__section">
          <h3 className="ai-settings__section-title">API 配置</h3>

          {app === "claude" ? (
            <>
              <Field label="API 端点" hint="留空使用官方端点 https://api.anthropic.com">
                <input
                  className="settings-view__input ai-settings__input"
                  value={claudeForm.baseUrl}
                  onChange={(e) => updateClaudeField("baseUrl", e.target.value)}
                  placeholder="https://api.anthropic.com"
                />
              </Field>

              <Field label="API Key" required>
                <input
                  className="settings-view__input ai-settings__input"
                  type="password"
                  value={claudeForm.apiKey}
                  onChange={(e) => updateClaudeField("apiKey", e.target.value)}
                  placeholder="sk-ant-..."
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="API Key" required>
                <input
                  className="settings-view__input ai-settings__input"
                  type="password"
                  value={codexForm.apiKey}
                  onChange={(e) => updateCodexAuthField(e.target.value)}
                  placeholder="sk-..."
                />
              </Field>

              <Field label="API 端点" required>
                <input
                  className="settings-view__input ai-settings__input"
                  value={codexForm.baseUrl}
                  onChange={(e) => updateCodexConfigField("baseUrl", e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </Field>

              <Field label="Provider ID">
                <input
                  className="settings-view__input ai-settings__input"
                  value={codexForm.modelProvider}
                  onChange={(e) => updateCodexConfigField("modelProvider", e.target.value)}
                  placeholder="custom"
                />
              </Field>

              <Field label="Wire API">
                <select
                  className="settings-view__input ai-settings__input"
                  value={codexForm.wireApi}
                  onChange={(e) => updateCodexConfigField("wireApi", e.target.value)}
                >
                  <option value="responses">responses</option>
                  <option value="chat">chat</option>
                </select>
              </Field>
            </>
          )}
        </div>

        <div className="ai-settings__section">
          <h3 className="ai-settings__section-title">模型配置</h3>

          {app === "claude" ? (
            <>
              <Field label="默认兜底模型" hint="用于未明确指定角色的请求">
                <input
                  className="settings-view__input ai-settings__input"
                  value={claudeForm.model}
                  onChange={(e) => updateClaudeField("model", e.target.value)}
                  placeholder="claude-opus-4-8"
                />
              </Field>

              <Field label="Sonnet 模型">
                <input
                  className="settings-view__input ai-settings__input"
                  value={claudeForm.sonnetModel}
                  onChange={(e) => updateClaudeField("sonnetModel", e.target.value)}
                  placeholder="claude-sonnet-4-6"
                />
              </Field>

              <Field label="Opus 模型">
                <input
                  className="settings-view__input ai-settings__input"
                  value={claudeForm.opusModel}
                  onChange={(e) => updateClaudeField("opusModel", e.target.value)}
                  placeholder="claude-opus-4-8"
                />
              </Field>

              <Field label="Haiku 模型">
                <input
                  className="settings-view__input ai-settings__input"
                  value={claudeForm.haikuModel}
                  onChange={(e) => updateClaudeField("haikuModel", e.target.value)}
                  placeholder="claude-haiku-4-5"
                />
              </Field>
            </>
          ) : (
            <Field label="模型名称" required>
              <input
                className="settings-view__input ai-settings__input"
                value={codexForm.model}
                onChange={(e) => updateCodexConfigField("model", e.target.value)}
                placeholder="gpt-5"
              />
            </Field>
          )}
        </div>

        <div className="ai-settings__section">
          <h3 className="ai-settings__section-title">配置文件</h3>

          {app === "claude" ? (
            <Field label="settings.json">
              <textarea
                className="ai-settings__textarea"
                value={claudeSettingsText}
                onChange={(e) => handleClaudeSettingsChange(e.target.value)}
                spellCheck={false}
              />
            </Field>
          ) : (
            <>
              <Field label="auth.json">
                <textarea
                  className="ai-settings__textarea ai-settings__textarea--short"
                  value={codexAuthText}
                  onChange={(e) => handleCodexAuthChange(e.target.value)}
                  spellCheck={false}
                />
              </Field>

              <Field label="config.toml">
                <textarea
                  className="ai-settings__textarea"
                  value={codexConfigText}
                  onChange={(e) => handleCodexConfigChange(e.target.value)}
                  spellCheck={false}
                />
              </Field>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type JsonRecord = Record<string, unknown>;

function emptyClaudeForm(): ClaudeFormData {
  return {
    baseUrl: "",
    apiKey: "",
    model: "",
    sonnetModel: "",
    opusModel: "",
    haikuModel: "",
  };
}

function emptyCodexForm(): CodexFormData {
  return {
    apiKey: "",
    baseUrl: "",
    model: "",
    modelProvider: "custom",
    wireApi: "responses",
  };
}

function defaultClaudeSettings(): JsonRecord {
  return { env: {} };
}

function defaultCodexAuth(): JsonRecord {
  return { OPENAI_API_KEY: "" };
}

function defaultCodexConfig(
  modelProvider = "custom",
  model = "",
  providerName = "custom",
  baseUrl = "",
  wireApi = "responses",
): string {
  return [
    `model_provider = "${escapeTomlString(modelProvider)}"`,
    `model = "${escapeTomlString(model)}"`,
    "",
    `[model_providers.${tomlTableKey(modelProvider)}]`,
    `name = "${escapeTomlString(providerName)}"`,
    `base_url = "${escapeTomlString(baseUrl)}"`,
    `wire_api = "${escapeTomlString(wireApi)}"`,
  ].join("\n");
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJsonObject(text: string, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} 不是有效 JSON：${(e as Error).message}`);
  }
  const obj = asRecord(parsed);
  if (!obj) throw new Error(`${label} 必须是 JSON 对象`);
  return obj;
}

function safeParseJsonObject(text: string): JsonRecord | null {
  try {
    return parseJsonObject(text, "JSON");
  } catch {
    return null;
  }
}

function claudeFormFromSettingsText(text: string): ClaudeFormData | null {
  const config = safeParseJsonObject(text);
  if (!config) return null;
  const env = asRecord(config.env) ?? {};
  return {
    baseUrl: stringValue(env.ANTHROPIC_BASE_URL),
    apiKey: stringValue(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
    model: stringValue(env.ANTHROPIC_MODEL),
    sonnetModel: stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
    opusModel: stringValue(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
    haikuModel: stringValue(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_SMALL_FAST_MODEL),
  };
}

function updateClaudeSettingsText(text: string, form: ClaudeFormData): string {
  const config = safeParseJsonObject(text) ?? defaultClaudeSettings();
  const env = { ...(asRecord(config.env) ?? {}) };
  env.ANTHROPIC_BASE_URL = form.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = form.apiKey;
  env.ANTHROPIC_MODEL = form.model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = form.sonnetModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = form.opusModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = form.haikuModel;
  config.env = env;
  return prettyJson(config);
}

function updateJsonTextField(text: string, field: string, value: string): string {
  const config = safeParseJsonObject(text) ?? {};
  config[field] = value;
  return prettyJson(config);
}

function codexFormFromTexts(authText: string, configText: string): CodexFormData {
  const auth = safeParseJsonObject(authText) ?? {};
  const modelProvider = extractTomlStringField(configText, "model_provider") || "custom";
  return {
    apiKey: stringValue(auth.OPENAI_API_KEY),
    baseUrl:
      extractCodexProviderField(configText, modelProvider, "base_url") ||
      extractTomlStringField(configText, "base_url"),
    model: extractTomlStringField(configText, "model"),
    modelProvider,
    wireApi:
      extractCodexProviderField(configText, modelProvider, "wire_api") ||
      extractTomlStringField(configText, "wire_api") ||
      "responses",
  };
}

function updateCodexConfigText(text: string, form: CodexFormData, providerName: string): string {
  const modelProvider = form.modelProvider.trim() || "custom";
  let next = text.trim()
    ? text
    : defaultCodexConfig(
        modelProvider,
        form.model,
        providerName || modelProvider,
        form.baseUrl,
        form.wireApi,
      );
  next = setTomlTopLevelString(next, "model_provider", modelProvider);
  next = setTomlTopLevelString(next, "model", form.model);
  next = setCodexProviderStringField(next, modelProvider, "name", providerName || modelProvider);
  next = setCodexProviderStringField(next, modelProvider, "base_url", form.baseUrl);
  next = setCodexProviderStringField(next, modelProvider, "wire_api", form.wireApi || "responses");
  return next;
}

function extractTomlStringField(text: string, field: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, "m");
  const match = text.match(pattern);
  return match?.[1] ? unescapeTomlString(match[1]) : "";
}

function extractCodexProviderField(text: string, providerId: string, field: string): string {
  const section = extractCodexProviderSection(text, providerId);
  return section ? extractTomlStringField(section, field) : "";
}

function extractCodexProviderSection(text: string, providerId: string): string {
  const lines = text.split(/\r?\n/);
  const start = findCodexProviderSectionStart(lines, providerId);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function setTomlTopLevelString(text: string, field: string, value: string): string {
  const line = `${field} = "${escapeTomlString(value)}"`;
  const lines = text.replace(/\s+$/g, "").split(/\r?\n/);
  const fieldPattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=`);
  let insertAt = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i] ?? "";
    if (/^\s*\[/.test(current)) {
      insertAt = i;
      break;
    }
    insertAt = i + 1;
    if (fieldPattern.test(current)) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  lines.splice(insertAt, 0, line);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function setCodexProviderStringField(
  text: string,
  providerId: string,
  field: string,
  value: string,
): string {
  const trimmed = text.replace(/\s+$/g, "");
  const header = `[model_providers.${tomlTableKey(providerId)}]`;
  if (!trimmed) return `${header}\n${field} = "${escapeTomlString(value)}"`;

  const lines = trimmed.split(/\r?\n/);
  const start = findCodexProviderSectionStart(lines, providerId);
  if (start < 0) {
    return `${trimmed}\n\n${header}\n${field} = "${escapeTomlString(value)}"`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }

  const fieldPattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*=`);
  const line = `${field} = "${escapeTomlString(value)}"`;
  for (let i = start + 1; i < end; i += 1) {
    if (fieldPattern.test(lines[i] ?? "")) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  lines.splice(end, 0, line);
  return lines.join("\n");
}

function findCodexProviderSectionStart(lines: string[], providerId: string): number {
  const bare = `[model_providers.${providerId}]`;
  const quoted = `[model_providers."${escapeTomlString(providerId)}"]`;
  return lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === bare || trimmed === quoted;
  });
}

function tomlTableKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `"${escapeTomlString(value)}"`;
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

interface AiSettingsViewProps {
  app: AiSettingsApp;
}

export function AiSettingsView({ app }: AiSettingsViewProps) {
  const [snapshot, setSnapshot] = useState<AiSettingsSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const providers = useMemo(() => {
    const manager = snapshot?.state.apps[app];
    return Object.values(manager?.providers ?? {}).sort((a, b) => {
      const ai = a.sortIndex ?? 0;
      const bi = b.sortIndex ?? 0;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
  }, [snapshot, app]);

  const currentId = snapshot?.state.apps[app].current ?? "";
  const selectedProvider = selectedId ? snapshot?.state.apps[app].providers[selectedId] : null;

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    await run(async () => {
      setSnapshot(await getAiSettings());
    }, false);
  }

  async function run(task: () => Promise<void>, showDone = true) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await task();
      if (showDone) {
        setMessage("已完成");
        setTimeout(() => setMessage(null), 2000);
      }
    } catch (e) {
      setError((e as Error).message);
      setTimeout(() => setError(null), 4000);
    } finally {
      setBusy(false);
    }
  }

  const openDetail = (providerId: string) => {
    setSelectedId(providerId);
    setError(null);
    setMessage(null);
  };

  const createProvider = () => {
    setSelectedId("__new__");
    setError(null);
    setMessage(null);
  };

  const handleDetailSave = (provider: AiSettingsProvider) => {
    void run(async () => {
      const originalId = selectedId === "__new__" ? undefined : (selectedId ?? undefined);
      const next = await saveAiProvider(app, provider, originalId, false);
      setSnapshot(next);
      setSelectedId(null);
    }, true);
  };

  const handleSwitch = (provider: AiSettingsProvider) => {
    if (provider.id === currentId) return;
    void run(async () => {
      const next = await switchAiSettingsProvider(app, provider.id);
      setSnapshot(next);
    }, true);
  };

  const handleDelete = (provider: AiSettingsProvider) => {
    if (provider.id === currentId) {
      alert("无法删除当前使用的 provider");
      return;
    }
    if (!confirm(`确定要删除 "${provider.name}"？`)) return;
    void run(async () => {
      const next = await deleteAiSettingsProvider(app, provider.id);
      setSnapshot(next);
    }, true);
  };

  const handleDuplicate = (provider: AiSettingsProvider) => {
    const newId = `${provider.id}-copy`;
    const newProvider: AiSettingsProvider = {
      ...provider,
      id: newId,
      name: `${provider.name} (副本)`,
    };
    void run(async () => {
      const next = await saveAiProvider(app, newProvider, undefined, false);
      setSnapshot(next);
    }, true);
  };

  const importLive = () =>
    run(async () => {
      const next = await importAiLiveProvider(app);
      setSnapshot(next);
    }, true);

  const paths = snapshot?.paths;
  const showDetail = selectedId !== null;

  if (showDetail) {
    return (
      <ProviderDetail
        app={app}
        provider={selectedId === "__new__" ? null : selectedProvider || null}
        onSave={handleDetailSave}
        busy={busy}
        error={error}
      />
    );
  }

  return (
    <div className="ai-settings">
      <div className="side-view__header ai-settings__header">
        <span className="side-view__title">API & Model</span>
        <button className="icon-btn" title="刷新" onClick={() => void refresh()}>
          <RefreshIcon />
        </button>
      </div>

      <div className="ai-settings__path">
        {app === "claude"
          ? (paths?.claude.settings ?? "~/.claude/settings.json")
          : (paths?.codex.config ?? "~/.codex/config.toml")}
      </div>

      <div className="ai-settings__toolbar">
        <button className="primary-btn" onClick={createProvider} disabled={busy}>
          新建
        </button>
        <button className="tb-btn" onClick={importLive} disabled={busy}>
          导入 live
        </button>
      </div>

      {error && <div className="ai-settings__banner ai-settings__banner--error">{error}</div>}
      {message && <div className="ai-settings__banner ai-settings__banner--success">{message}</div>}

      <div className="ai-settings__card-list">
        {providers.length === 0 ? (
          <div className="ai-settings__empty">暂无 provider</div>
        ) : (
          providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isCurrent={provider.id === currentId}
              onClick={() => openDetail(provider.id)}
              onSwitch={() => handleSwitch(provider)}
              onDelete={() => handleDelete(provider)}
              onDuplicate={() => handleDuplicate(provider)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}

function Field({ label, hint, required, children }: FieldProps) {
  return (
    <div className="ai-settings__field">
      <label className="ai-settings__label">
        {label}
        {required && <span className="ai-settings__required">*</span>}
      </label>
      {children}
      {hint && <div className="ai-settings__hint">{hint}</div>}
    </div>
  );
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

function BackIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 12L6 8l4-4" />
    </svg>
  );
}

function CopyIcon() {
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
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M2 8V2h6" />
    </svg>
  );
}

function TrashIcon() {
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
      <path d="M3 4h10" />
      <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
      <path d="M6 7v4" />
      <path d="M10 7v4" />
      <path d="M4 4h8l-1 9H5L4 4z" />
    </svg>
  );
}
