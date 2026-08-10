import { useEffect, useState } from "react";
import packageJson from "../../package.json";
import {
  type LanguagePreference,
  type ThemePreference,
  useUiPreferences,
} from "../i18n/UiPreferences";
import { syncModelPrices } from "./api";
import type { ModelPrice, OsheepSettings, TabSize } from "./settings";

interface SettingsViewProps {
  settings: OsheepSettings;
  onChange: (settings: OsheepSettings) => void;
}

const MIN_FONT = 8;
const MAX_FONT = 64;
type SettingsSection = "general" | "editor" | "pricing" | "about";

export function SettingsView({ settings, onChange }: SettingsViewProps) {
  const { language, setLanguage, theme, setTheme, t } = useUiPreferences();
  const [section, setSection] = useState<SettingsSection>("general");
  const [search, setSearch] = useState("");

  const commitFontSize = (raw: string): number => {
    const value = Number.parseInt(raw, 10);
    if (Number.isNaN(value)) return settings.editor.fontSize;
    return Math.max(MIN_FONT, Math.min(MAX_FONT, value));
  };

  const applyFontSize = (raw: string) => {
    const next = commitFontSize(raw);
    if (next !== settings.editor.fontSize) {
      onChange({ ...settings, editor: { ...settings.editor, fontSize: next } });
    }
    return next;
  };

  const applyTabSize = (next: TabSize) => {
    if (next === settings.editor.tabSize) return;
    onChange({ ...settings, editor: { ...settings.editor, tabSize: next } });
  };

  const applyAutoSave = (autoSave: boolean) => {
    if (autoSave === settings.editor.autoSave) return;
    onChange({ ...settings, editor: { ...settings.editor, autoSave } });
  };

  const navItems: Array<{ id: SettingsSection; label: string; icon: string }> = [
    { id: "general", label: t("settings.category.general"), icon: "settings-gear" },
    { id: "editor", label: t("settings.category.editor"), icon: "settings-edit" },
    { id: "pricing", label: t("settings.category.pricing"), icon: "settings-symbol" },
    { id: "about", label: t("settings.category.about"), icon: "settings-info" },
  ];
  const normalizedSearch = search.trim().toLowerCase();
  const matches = (value: string) => !normalizedSearch || value.toLowerCase().includes(normalizedSearch);

  return (
    <div className="settings-view">
      <div className="settings-view__topbar">
        <div className="settings-view__search-wrap">
          <span className="codicon codicon-search" aria-hidden="true" />
          <input
            className="settings-view__search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("settings.search")}
            aria-label={t("settings.search")}
          />
        </div>
      </div>
      <div className="settings-view__layout">
        <nav className="settings-view__nav" aria-label={t("settings.categories")}>
          <div className="settings-view__nav-heading">{t("settings.categories")}</div>
          {navItems.filter((item) => matches(item.label)).map((item) => (
            <button
              type="button"
              key={item.id}
              className={`settings-view__nav-item${section === item.id ? " is-active" : ""}`}
              onClick={() => setSection(item.id)}
            >
              <span className={`codicon codicon-${item.icon}`} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <main className="settings-view__content">
          <h1 className="settings-view__title">{navItems.find((item) => item.id === section)?.label}</h1>

          {section === "general" && <>
          <section className="settings-view__group">
          <h2 className="settings-view__group-title">{t("settings.appearance")}</h2>

          <SettingItem
            label={t("settings.language")}
            description={t("settings.language.description")}
          >
            <Segmented<LanguagePreference>
              value={language}
              options={[
                { label: t("settings.language.system"), value: "system" },
                { label: t("settings.language.zhCN"), value: "zh-CN" },
                { label: t("settings.language.en"), value: "en" },
              ]}
              onChange={setLanguage}
            />
          </SettingItem>

          <SettingItem label={t("settings.theme")} description={t("settings.theme.description")}>
            <Segmented<ThemePreference>
              value={theme}
              options={[
                { label: t("settings.theme.system"), value: "system" },
                { label: t("settings.theme.light"), value: "light" },
                { label: t("settings.theme.dark"), value: "dark" },
              ]}
              onChange={setTheme}
            />
          </SettingItem>
          </section>
          </>}

          {section === "editor" && <section className="settings-view__group">
          <h2 className="settings-view__group-title">{t("settings.editor")}</h2>
          <div className="settings-view__hint">{t("settings.editor.projectHint")}</div>

          <SettingItem
            label={t("settings.editor.autoSave")}
            description={t("settings.editor.autoSaveDescription")}
          >
            <Switch
              checked={settings.editor.autoSave}
              label={t("settings.editor.autoSave")}
              onChange={applyAutoSave}
            />
          </SettingItem>

          <SettingItem
            label={t("settings.editor.fontSize")}
            description={t("settings.editor.fontSizeDescription", {
              min: MIN_FONT,
              max: MAX_FONT,
            })}
          >
            <NumberInput value={settings.editor.fontSize} onCommit={applyFontSize} />
          </SettingItem>

          <SettingItem
            label={t("settings.editor.tabSize")}
            description={t("settings.editor.tabSizeDescription")}
          >
            <Segmented<TabSize>
              value={settings.editor.tabSize}
              options={[
                { label: t("settings.editor.spaces", { count: 2 }), value: 2 },
                { label: t("settings.editor.spaces", { count: 4 }), value: 4 },
              ]}
              onChange={applyTabSize}
            />
          </SettingItem>
          </section>}
          {section === "pricing" && <ModelPricingPanel settings={settings} onChange={onChange} />}
          {section === "about" && <AboutPanel />}
        </main>
      </div>
    </div>
  );
}

function ModelPricingPanel({ settings, onChange }: SettingsViewProps) {
  const { t } = useUiPreferences();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const models = settings.pricing.models;
  const visible = models.filter((model) => model.model.toLowerCase().includes(query.trim().toLowerCase()));
  const rendered = visible.slice(0, 250);
  const updateModels = (next: ModelPrice[]) => onChange({ ...settings, pricing: { models: next } });
  const updateModel = (index: number, patch: Partial<ModelPrice>) => {
    const next = models.map((model, current) => (current === index ? { ...model, ...patch } : model));
    updateModels(next);
  };
  const sync = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await syncModelPrices();
      const merged = new Map(
        response.models.map((model) => [model.model.trim().toLowerCase(), model] as const),
      );
      for (const model of models) {
        if (model.source === "manual") merged.set(model.model.trim().toLowerCase(), model);
      }
      updateModels([...merged.values()].sort((a, b) => a.model.localeCompare(b.model)));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-view__group settings-pricing">
      <div className="settings-pricing__toolbar">
        <div>
          <h2 className="settings-view__group-title">{t("settings.pricing.title")}</h2>
          <p className="settings-view__hint">{t("settings.pricing.description")}</p>
        </div>
        <div className="settings-pricing__actions">
          <button type="button" className="settings-view__button" onClick={() => updateModels([...models, { model: "", inputCostPerMillion: 0, outputCostPerMillion: 0, source: "manual" }])}>
            {t("settings.pricing.add")}
          </button>
          <button type="button" className="settings-view__button is-primary" onClick={() => void sync()} disabled={busy}>
            {busy ? t("settings.pricing.syncing") : t("settings.pricing.sync")}
          </button>
        </div>
      </div>
      <input className="settings-view__input settings-pricing__search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.pricing.search")} />
      {error && <div className="settings-view__error">{error}</div>}
      <div className="settings-pricing__table">
        <div className="settings-pricing__row settings-pricing__row--head"><span>{t("settings.pricing.model")}</span><span>{t("settings.pricing.input")}</span><span>{t("settings.pricing.output")}</span><span /></div>
        {rendered.map((model) => {
          const index = models.indexOf(model);
          return <div className="settings-pricing__row" key={`${model.model}-${index}`}>
            <input className="settings-view__input" defaultValue={model.model} placeholder="provider/model" onBlur={(event) => updateModel(index, { model: event.target.value.trim(), source: "manual" })} />
            <input className="settings-view__input" type="number" min="0" step="any" defaultValue={model.inputCostPerMillion} onBlur={(event) => updateModel(index, { inputCostPerMillion: Math.max(0, Number(event.target.value) || 0), source: "manual" })} />
            <input className="settings-view__input" type="number" min="0" step="any" defaultValue={model.outputCostPerMillion} onBlur={(event) => updateModel(index, { outputCostPerMillion: Math.max(0, Number(event.target.value) || 0), source: "manual" })} />
            <button type="button" className="settings-view__icon-button" onClick={() => updateModels(models.filter((_, current) => current !== index))} aria-label={t("settings.pricing.remove")} title={t("settings.pricing.remove")}><span className="codicon codicon-trash" /></button>
          </div>;
        })}
        {visible.length === 0 && <div className="settings-view__empty">{t("settings.pricing.empty")}</div>}
        {visible.length > rendered.length && <div className="settings-view__hint">{t("settings.pricing.showing", { shown: rendered.length, total: visible.length })}</div>}
      </div>
    </section>
  );
}

function AboutPanel() {
  const { t } = useUiPreferences();
  return <section className="settings-view__group settings-about">
    <h2 className="settings-view__group-title">{t("settings.about.title")}</h2>
    <div className="settings-about__brand"><span className="settings-about__mark">O</span><div><strong>osheep</strong><span>{t("settings.about.tagline")}</span></div></div>
    <dl className="settings-about__facts"><div><dt>{t("settings.about.version")}</dt><dd>{packageJson.version}</dd></div><div><dt>{t("settings.about.repository")}</dt><dd><a href={packageJson.repository} target="_blank" rel="noreferrer">{packageJson.repository}</a></dd></div><div><dt>{t("settings.about.license")}</dt><dd>MIT</dd></div></dl>
  </section>;
}

interface SwitchProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

function Switch({ checked, disabled = false, label, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      className={`settings-view__switch${checked ? " is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-view__switch-thumb" />
    </button>
  );
}

function SettingItem({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-view__item">
      <div className="settings-view__item-label">{label}</div>
      <div className="settings-view__item-desc">{description}</div>
      {children}
    </div>
  );
}

interface NumberInputProps {
  value: number;
  disabled?: boolean;
  onCommit: (raw: string) => number;
}

function NumberInput({ value, disabled = false, onCommit }: NumberInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => setDraft(String(onCommit(draft)));

  return (
    <input
      type="number"
      className="settings-view__input"
      value={draft}
      disabled={disabled}
      min={MIN_FONT}
      max={MAX_FONT}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

interface SegmentedProps<T extends string | number> {
  value: T;
  options: { label: string; value: T }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}

function Segmented<T extends string | number>({
  value,
  options,
  disabled = false,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="settings-view__segmented">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          disabled={disabled}
          className={`settings-view__seg${option.value === value ? " is-active" : ""}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
