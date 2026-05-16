export type TabSize = 2 | 4;

export interface OsheepSettings {
  editor: {
    fontSize: number;
    tabSize: TabSize;
  };
}

export const DEFAULT_SETTINGS: OsheepSettings = {
  editor: { fontSize: 14, tabSize: 2 },
};

export function mergeSettings(partial: unknown): OsheepSettings {
  const p = (partial ?? {}) as {
    editor?: { fontSize?: unknown; tabSize?: unknown };
  };
  const fontSize =
    typeof p.editor?.fontSize === "number" &&
    p.editor.fontSize >= 8 &&
    p.editor.fontSize <= 64
      ? p.editor.fontSize
      : DEFAULT_SETTINGS.editor.fontSize;
  const tabSize: TabSize =
    p.editor?.tabSize === 4 ? 4 : 2;
  return { editor: { fontSize, tabSize } };
}
