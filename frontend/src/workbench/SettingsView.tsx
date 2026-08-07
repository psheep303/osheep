import { useEffect, useState } from "react";
import {
  type LanguagePreference,
  type ThemePreference,
  useUiPreferences,
} from "../i18n/UiPreferences";
import type { OsheepSettings, TabSize } from "./settings";

interface SettingsViewProps {
  settings: OsheepSettings;
  onChange: (settings: OsheepSettings) => void;
}

const MIN_FONT = 8;
const MAX_FONT = 64;

export function SettingsView({ settings, onChange }: SettingsViewProps) {
  const { language, setLanguage, theme, setTheme, t } = useUiPreferences();

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

  return (
    <div className="settings-view">
      <div className="settings-view__container">
        <h1 className="settings-view__title">{t("settings.title")}</h1>

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

        <section className="settings-view__group">
          <h2 className="settings-view__group-title">{t("settings.editor")}</h2>
          <div className="settings-view__hint">
            {t("settings.editor.projectHint")}
          </div>

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
            <NumberInput
              value={settings.editor.fontSize}
              onCommit={applyFontSize}
            />
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
        </section>
      </div>
    </div>
  );
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
