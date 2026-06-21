import { useEffect, useState } from "react";
import type { AiProvider, OsheepSettings, TabSize } from "./settings";
import { newProviderId } from "./settings";
import { fetchProviderModels } from "./api";

interface SettingsViewProps {
  settings: OsheepSettings;
  onChange: (s: OsheepSettings) => void;
  hasProject: boolean;
  workspaceId: string | null;
}

const MIN_FONT = 8;
const MAX_FONT = 64;

export function SettingsView({
  settings,
  onChange,
  hasProject,
  workspaceId,
}: SettingsViewProps) {
  const commitFontSize = (raw: string): number => {
    const n = parseInt(raw, 10);
    const fallback = settings.editor.fontSize;
    if (Number.isNaN(n)) return fallback;
    return Math.max(MIN_FONT, Math.min(MAX_FONT, n));
  };

  const applyFontSize = (raw: string) => {
    const next = commitFontSize(raw);
    if (next !== settings.editor.fontSize) {
      onChange({
        ...settings,
        editor: { ...settings.editor, fontSize: next },
      });
    }
    return next;
  };

  const applyTabSize = (next: TabSize) => {
    if (next === settings.editor.tabSize) return;
    onChange({
      ...settings,
      editor: { ...settings.editor, tabSize: next },
    });
  };

  const setProviders = (providers: AiProvider[]) => {
    onChange({ ...settings, ai: { ...settings.ai, providers } });
  };

  const addProvider = () => {
    setProviders([
      ...settings.ai.providers,
      {
        id: newProviderId(),
        name: "新 Provider",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        models: [],
      },
    ]);
  };

  const updateProvider = (id: string, patch: Partial<AiProvider>) => {
    setProviders(
      settings.ai.providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    );
  };

  const removeProvider = (id: string) => {
    setProviders(settings.ai.providers.filter((p) => p.id !== id));
  };

  return (
    <div className="settings-view">
      <div className="settings-view__container">
        <div className="settings-view__title">设置</div>
        <div className="settings-view__hint">
          {hasProject
            ? "设置保存在当前项目的 .osheep/settings.json"
            : "请打开项目后再修改设置，未打开项目时无法持久化"}
        </div>

        <div className="settings-view__group">
          <div className="settings-view__group-title">编辑器</div>

          <div className="settings-view__item">
            <div className="settings-view__item-label">字体大小</div>
            <div className="settings-view__item-desc">
              控制编辑器字体大小，单位 px。范围 {MIN_FONT}–{MAX_FONT}，输入完成后（失焦或回车）才应用，超出范围会自动收敛。
            </div>
            <NumberInput
              value={settings.editor.fontSize}
              disabled={!hasProject}
              onCommit={applyFontSize}
            />
          </div>

          <div className="settings-view__item">
            <div className="settings-view__item-label">Tab 缩进</div>
            <div className="settings-view__item-desc">
              按 Tab 键插入的空格数（同时影响自动缩进宽度）。
            </div>
            <Segmented<TabSize>
              value={settings.editor.tabSize}
              disabled={!hasProject}
              options={[
                { label: "2 空格", value: 2 },
                { label: "4 空格", value: 4 },
              ]}
              onChange={applyTabSize}
            />
          </div>
        </div>

        <div className="settings-view__group">
          <div className="settings-view__group-title">AI</div>
          <div className="settings-view__item-desc">
            维护可用的模型 Provider。每个 Provider 兼容 OpenAI API，可填写 Base URL、API Key 与模型列表，供对话使用。
          </div>

          <div className="settings-view__item">
            <div className="settings-view__item-label">默认对话模型</div>
            <div className="settings-view__item-desc">
              所有对话框（osheep code）将固定使用此 Provider 与 Model。对话框中不再提供切换入口。
            </div>
            <DefaultModelPicker
              providers={settings.ai.providers}
              providerId={settings.ai.defaultProviderId ?? settings.ai.lastProviderId ?? ""}
              model={settings.ai.defaultModel ?? settings.ai.lastModel ?? ""}
              disabled={!hasProject}
              onChange={(pid, m) =>
                onChange({
                  ...settings,
                  ai: {
                    ...settings.ai,
                    defaultProviderId: pid || undefined,
                    defaultModel: m || undefined,
                  },
                })
              }
            />
          </div>

          {settings.ai.providers.length === 0 && (
            <div className="settings-view__empty">尚未配置任何 Provider</div>
          )}

          {settings.ai.providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              disabled={!hasProject}
              workspaceId={workspaceId}
              onChange={(patch) => updateProvider(p.id, patch)}
              onRemove={() => removeProvider(p.id)}
            />
          ))}

          <button
            type="button"
            className="primary-btn settings-view__add"
            disabled={!hasProject}
            onClick={addProvider}
          >
            + 新建 Provider
          </button>
        </div>
      </div>
    </div>
  );
}

interface ProviderCardProps {
  provider: AiProvider;
  disabled: boolean;
  workspaceId: string | null;
  onChange: (patch: Partial<AiProvider>) => void;
  onRemove: () => void;
}

function ProviderCard({
  provider,
  disabled,
  workspaceId,
  onChange,
  onRemove,
}: ProviderCardProps) {
  const [modelDraft, setModelDraft] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [picker, setPicker] = useState<string[] | null>(null);
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());

  const addModel = () => {
    const v = modelDraft.trim();
    if (!v) return;
    if (provider.models.includes(v)) {
      setModelDraft("");
      return;
    }
    onChange({ models: [...provider.models, v] });
    setModelDraft("");
  };

  const removeModel = (m: string) => {
    onChange({ models: provider.models.filter((x) => x !== m) });
  };

  const fetchModels = async () => {
    if (!workspaceId || !provider.baseUrl || !provider.apiKey) {
      setFetchError("需要先填写 Base URL 与 API Key");
      return;
    }
    setFetching(true);
    setFetchError(null);
    setPicker(null);
    try {
      const list = await fetchProviderModels(
        workspaceId,
        provider.baseUrl,
        provider.apiKey,
        provider.kind
      );
      setPicker(list);
      setPickerSelected(new Set(provider.models.filter((m) => list.includes(m))));
    } catch (e) {
      setFetchError((e as Error).message);
    } finally {
      setFetching(false);
    }
  };

  const applyPicker = () => {
    if (!picker) return;
    const next = Array.from(new Set([...provider.models, ...pickerSelected]));
    // keep already-selected order, append new selected
    onChange({ models: next });
    setPicker(null);
  };

  const togglePick = (m: string) => {
    setPickerSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };

  return (
    <div className="provider-card">
      <div className="provider-card__row">
        <label className="provider-card__label">名称</label>
        <input
          className="settings-view__input"
          value={provider.name}
          disabled={disabled}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <button
          type="button"
          className="provider-card__remove"
          disabled={disabled}
          onClick={onRemove}
          title="删除 Provider"
        >
          删除
        </button>
      </div>
      <div className="provider-card__row">
        <label className="provider-card__label">协议</label>
        <select
          className="settings-view__input"
          value={provider.kind}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              kind: v === "anthropic" ? "anthropic" : v === "claude-code" ? "claude-code" : "openai"
            });
          }}
        >
          <option value="openai">OpenAI 兼容（/chat/completions）</option>
          <option value="anthropic">Anthropic API（/v1/messages）</option>
          <option value="claude-code">Claude Code 原生方式</option>
        </select>
      </div>
      <div className="provider-card__row">
        <label className="provider-card__label">Base URL</label>
        <input
          className="settings-view__input"
          value={provider.baseUrl}
          disabled={disabled}
          placeholder={
            provider.kind === "anthropic" || provider.kind === "claude-code"
              ? "https://api.anthropic.com/v1"
              : "https://api.openai.com/v1"
          }
          onChange={(e) => onChange({ baseUrl: e.target.value })}
        />
      </div>
      <div className="provider-card__row">
        <label className="provider-card__label">API Key</label>
        <input
          className="settings-view__input"
          type="password"
          value={provider.apiKey}
          disabled={disabled}
          placeholder="sk-..."
          onChange={(e) => onChange({ apiKey: e.target.value })}
        />
      </div>
      <div className="provider-card__row provider-card__row--top">
        <label className="provider-card__label">模型</label>
        <div className="provider-card__models">
          {provider.models.length === 0 && (
            <div className="settings-view__empty">尚未添加模型</div>
          )}
          {provider.models.map((m) => (
            <span key={m} className="provider-card__chip">
              {m}
              <button
                type="button"
                className="provider-card__chip-remove"
                disabled={disabled}
                onClick={() => removeModel(m)}
                title="移除"
              >
                ×
              </button>
            </span>
          ))}
          <div className="provider-card__model-input">
            <input
              className="settings-view__input"
              value={modelDraft}
              disabled={disabled}
              placeholder="模型 ID，如 gpt-4o-mini"
              onChange={(e) => setModelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addModel();
                }
              }}
            />
            <button
              type="button"
              className="settings-view__seg"
              disabled={disabled || modelDraft.trim() === ""}
              onClick={addModel}
            >
              添加
            </button>
            <button
              type="button"
              className="settings-view__seg"
              disabled={
                disabled ||
                fetching ||
                !provider.baseUrl ||
                !provider.apiKey ||
                !workspaceId
              }
              onClick={() => void fetchModels()}
              title="调用 {baseUrl}/models 拉取可用模型"
            >
              {fetching ? "获取中…" : "获取模型"}
            </button>
          </div>
          {fetchError && (
            <div className="provider-card__error">{fetchError}</div>
          )}
          {picker && (
            <div className="provider-card__picker">
              <div className="provider-card__picker-header">
                <span>选择要加入的模型（{picker.length}）</span>
                <button
                  type="button"
                  className="provider-card__chip-remove"
                  onClick={() => setPicker(null)}
                  title="取消"
                >
                  ×
                </button>
              </div>
              <div className="provider-card__picker-list">
                {picker.length === 0 && (
                  <div className="settings-view__empty">上游未返回任何模型</div>
                )}
                {picker.map((m) => (
                  <label key={m} className="provider-card__picker-item">
                    <input
                      type="checkbox"
                      checked={pickerSelected.has(m)}
                      onChange={() => togglePick(m)}
                    />
                    <span>{m}</span>
                  </label>
                ))}
              </div>
              <div className="provider-card__picker-actions">
                <button
                  type="button"
                  className="settings-view__seg is-active"
                  onClick={applyPicker}
                  disabled={pickerSelected.size === 0}
                >
                  加入选中（{pickerSelected.size}）
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface NumberInputProps {
  value: number;
  disabled: boolean;
  onCommit: (raw: string) => number;
}

function DefaultModelPicker({
  providers,
  providerId,
  model,
  disabled,
  onChange,
}: {
  providers: AiProvider[];
  providerId: string;
  model: string;
  disabled: boolean;
  onChange: (providerId: string, model: string) => void;
}) {
  if (providers.length === 0) {
    return (
      <div className="settings-view__empty">
        请先在下方新建 Provider 并添加模型
      </div>
    );
  }
  const selectedProvider = providers.find((p) => p.id === providerId) ?? null;
  return (
    <div className="provider-card__row" style={{ marginBottom: 0 }}>
      <select
        className="settings-view__input"
        value={providerId}
        disabled={disabled}
        onChange={(e) => {
          const pid = e.target.value;
          const next = providers.find((p) => p.id === pid);
          onChange(pid, next?.models[0] ?? "");
        }}
        style={{ width: 200 }}
      >
        <option value="">（未选择 Provider）</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || p.id}
          </option>
        ))}
      </select>
      <select
        className="settings-view__input"
        value={model}
        disabled={disabled || !selectedProvider}
        onChange={(e) => onChange(providerId, e.target.value)}
        style={{ width: 240 }}
      >
        <option value="">（未选择 Model）</option>
        {selectedProvider?.models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}

function NumberInput({ value, disabled, onCommit }: NumberInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const applied = onCommit(draft);
    setDraft(String(applied));
  };

  return (
    <input
      type="number"
      className="settings-view__input"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(String(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

interface SegmentedProps<T extends string | number> {
  value: T;
  options: { label: string; value: T }[];
  disabled: boolean;
  onChange: (v: T) => void;
}

function Segmented<T extends string | number>({
  value,
  options,
  disabled,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="settings-view__segmented">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          disabled={disabled}
          className={
            "settings-view__seg" + (opt.value === value ? " is-active" : "")
          }
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
