import { useEffect, useState } from "react";
import type { OsheepSettings, TabSize } from "./settings";

interface SettingsViewProps {
  settings: OsheepSettings;
  onChange: (s: OsheepSettings) => void;
  hasProject: boolean;
}

const MIN_FONT = 8;
const MAX_FONT = 64;

export function SettingsView({
  settings,
  onChange,
  hasProject,
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
      </div>
    </div>
  );
}

interface NumberInputProps {
  value: number;
  disabled: boolean;
  onCommit: (raw: string) => number;
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
