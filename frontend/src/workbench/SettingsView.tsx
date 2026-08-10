import { useEffect, useRef, useState } from "react";
import packageJson from "../../package.json";
import {
  type LanguagePreference,
  type ThemePreference,
  useUiPreferences,
} from "../i18n/UiPreferences";
import { syncModelPrices } from "./api";
import {
  canonicalPriceModelName,
  inferModelOriginProvider,
  type ModelPrice,
  type OsheepSettings,
  type TabSize,
} from "./settings";

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
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ModelPrice>(() => emptyModelPrice());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const models = settings.pricing.models;
  const normalizedQuery = query.trim().toLowerCase();
  const visible = [...models]
    .filter((model) => `${model.model} ${model.provider}`.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => Number(b.favorite === true) - Number(a.favorite === true) || a.model.localeCompare(b.model));
  const pageCount = Math.max(1, Math.ceil(visible.length / 50));
  const currentPage = Math.min(page, pageCount);
  const rendered = visible.slice((currentPage - 1) * 50, currentPage * 50);
  const updateModels = (next: ModelPrice[]) => onChange({ ...settings, pricing: { models: next } });
  const updateModel = (index: number, patch: Partial<ModelPrice>) => {
    const next = models.map((model, current) => (current === index ? { ...model, ...patch } : model));
    updateModels(next);
  };
  useEffect(() => setPage(1), [query]);
  const sync = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await syncModelPrices();
      const merged = new Map(
        response.models.map((model) => [model.model.trim().toLowerCase(), model] as const),
      );
      for (const model of models) {
        const key = model.model.trim().toLowerCase();
        if (model.source === "manual") merged.set(key, model);
        else if (model.favoriteCustomized && merged.has(key)) {
          merged.set(key, {
            ...merged.get(key)!,
            favorite: model.favorite,
            favoriteCustomized: true,
          });
        } else if (model.favorite && merged.has(key)) {
          merged.set(key, { ...merged.get(key)!, favorite: true });
        }
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
          <button type="button" className="settings-view__button" onClick={() => { setDraft(emptyModelPrice()); setAdding(true); }}>
            {t("settings.pricing.add")}
          </button>
          <button type="button" className="settings-view__button is-primary" onClick={() => void sync()} disabled={busy}>
            {busy ? t("settings.pricing.syncing") : t("settings.pricing.sync")}
          </button>
        </div>
      </div>
      <input className="settings-view__input settings-pricing__search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.pricing.search")} />
      {error && <div className="settings-view__error">{error}</div>}
      <div className="settings-pricing__table-wrap">
      <div className="settings-pricing__table">
        <div className="settings-pricing__row settings-pricing__row--head"><span /><span>{t("settings.pricing.model")}</span><span>{t("settings.pricing.provider")}</span><span>{t("settings.pricing.billingMode")}</span><span>{t("settings.pricing.perRequest")}</span><span>{t("settings.pricing.input")}</span><span>{t("settings.pricing.output")}</span><span>{t("settings.pricing.cacheRead")}</span><span>{t("settings.pricing.cacheWrite")}</span><span /></div>
        {adding && <div className="settings-pricing__row is-adding">
          <span />
          <input className="settings-view__input" value={draft.model} placeholder="provider/model" onChange={(event) => setDraft({ ...draft, model: event.target.value })} autoFocus />
          <input className="settings-view__input" value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} />
          <select className="settings-view__input" value={draft.billingMode} onChange={(event) => setDraft({ ...draft, billingMode: event.target.value === "per-request" ? "per-request" : "dynamic" })}><option value="dynamic">{t("settings.pricing.dynamic")}</option><option value="per-request">{t("settings.pricing.perRequestMode")}</option></select>
          <PriceInput value={draft.costPerRequest} onCommit={(value) => setDraft({ ...draft, costPerRequest: value })} />
          <PriceInput value={draft.inputCostPerMillion} onCommit={(value) => setDraft({ ...draft, inputCostPerMillion: value })} />
          <PriceInput value={draft.outputCostPerMillion} onCommit={(value) => setDraft({ ...draft, outputCostPerMillion: value })} />
          <PriceInput value={draft.cacheReadCostPerMillion} onCommit={(value) => setDraft({ ...draft, cacheReadCostPerMillion: value })} />
          <PriceInput value={draft.cacheWriteCostPerMillion} onCommit={(value) => setDraft({ ...draft, cacheWriteCostPerMillion: value })} />
          <div className="settings-pricing__row-actions"><button type="button" className="settings-view__icon-button" disabled={!draft.model.trim()} onClick={() => { const model = canonicalPriceModelName(draft.model); updateModels([...models, { ...draft, model, provider: draft.provider.trim() || inferModelOriginProvider(draft.model) }]); setAdding(false); }} title={t("common.save")}><span className="codicon codicon-check" /></button><button type="button" className="settings-view__icon-button" onClick={() => setAdding(false)} title={t("common.cancel")}><span className="codicon codicon-close" /></button></div>
        </div>}
        {rendered.map((model) => {
          const index = models.indexOf(model);
          return <div className="settings-pricing__row" key={`${model.model}-${index}`}>
            <button type="button" className={`settings-pricing__favorite${model.favorite ? " is-active" : ""}`} onClick={() => updateModel(index, { favorite: !model.favorite, favoriteCustomized: true })} aria-label={t("settings.pricing.favorite")} title={t("settings.pricing.favorite")}><span className={`codicon codicon-star-${model.favorite ? "full" : "empty"}`} /></button>
            <span className="settings-pricing__model" title={model.model}>{model.model}</span>
            <input className="settings-view__input" defaultValue={model.provider} onBlur={(event) => updateModel(index, { provider: event.target.value.trim(), source: "manual" })} />
            <select className="settings-view__input" defaultValue={model.billingMode} onChange={(event) => updateModel(index, { billingMode: event.target.value === "per-request" ? "per-request" : "dynamic", source: "manual" })}><option value="dynamic">{t("settings.pricing.dynamic")}</option><option value="per-request">{t("settings.pricing.perRequestMode")}</option></select>
            <PriceInput value={model.costPerRequest} onCommit={(value) => updateModel(index, { costPerRequest: value, source: "manual" })} />
            <PriceInput value={model.inputCostPerMillion} onCommit={(value) => updateModel(index, { inputCostPerMillion: value, source: "manual" })} />
            <PriceInput value={model.outputCostPerMillion} onCommit={(value) => updateModel(index, { outputCostPerMillion: value, source: "manual" })} />
            <PriceInput value={model.cacheReadCostPerMillion} onCommit={(value) => updateModel(index, { cacheReadCostPerMillion: value, source: "manual" })} />
            <PriceInput value={model.cacheWriteCostPerMillion} onCommit={(value) => updateModel(index, { cacheWriteCostPerMillion: value, source: "manual" })} />
            <button type="button" className="settings-view__icon-button" onClick={() => updateModels(models.filter((_, current) => current !== index))} aria-label={t("settings.pricing.remove")} title={t("settings.pricing.remove")}><span className="codicon codicon-trash" /></button>
          </div>;
        })}
        {visible.length === 0 && <div className="settings-view__empty">{t("settings.pricing.empty")}</div>}
      </div>
      </div>
      <div className="settings-pricing__pagination"><span>{t("settings.pricing.count", { total: visible.length })}</span><div><button type="button" className="settings-view__icon-button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label={t("settings.pricing.previous")}><span className="codicon codicon-chevron-left" /></button><span>{currentPage} / {pageCount}</span><button type="button" className="settings-view__icon-button" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} aria-label={t("settings.pricing.next")}><span className="codicon codicon-chevron-right" /></button></div></div>
    </section>
  );
}

function PriceInput({ value, onCommit }: { value: number | undefined; onCommit: (value: number) => void }) {
  const formattedValue = (value ?? 0).toFixed(2);
  const [draft, setDraft] = useState(formattedValue);
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) setDraft(formattedValue);
  }, [formattedValue]);

  const commit = () => {
    if (!dirty.current) return;
    const next = Math.round(Math.max(0, Number(draft) || 0) * 100) / 100;
    setDraft(next.toFixed(2));
    dirty.current = false;
    onCommit(next);
  };

  return <input
    className="settings-view__input settings-pricing__price"
    type="number"
    min="0"
    step="0.01"
    value={draft}
    onChange={(event) => {
      setDraft(event.target.value);
      dirty.current = true;
    }}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        dirty.current = false;
        setDraft(formattedValue);
        event.currentTarget.blur();
      }
    }}
  />;
}

function emptyModelPrice(): ModelPrice {
  return { model: "", provider: "", billingMode: "dynamic", costPerRequest: 0, inputCostPerMillion: 0, outputCostPerMillion: 0, cacheReadCostPerMillion: 0, cacheWriteCostPerMillion: 0, favorite: false, source: "manual" };
}

function AboutPanel() {
  const { t } = useUiPreferences();
  return <section className="settings-view__group settings-about">
    <h2 className="settings-view__group-title">{t("settings.about.title")}</h2>
    <div className="settings-about__brand"><img className="settings-about__mark" src="/osheep-icon.png" alt="osheep" /><div><strong>osheep</strong><span>{t("settings.about.tagline")}</span></div></div>
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
