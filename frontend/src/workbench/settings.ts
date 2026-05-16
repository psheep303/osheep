export interface OsheepSettings {
  editor: {
    fontSize: number;
  };
}

export const DEFAULT_SETTINGS: OsheepSettings = {
  editor: { fontSize: 14 },
};

export function mergeSettings(partial: unknown): OsheepSettings {
  const p = (partial ?? {}) as { editor?: { fontSize?: unknown } };
  const fontSize =
    typeof p.editor?.fontSize === "number" &&
    p.editor.fontSize >= 8 &&
    p.editor.fontSize <= 64
      ? p.editor.fontSize
      : DEFAULT_SETTINGS.editor.fontSize;
  return { editor: { fontSize } };
}
