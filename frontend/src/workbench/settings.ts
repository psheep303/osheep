export type TabSize = 2 | 4;

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface OsheepSettings {
  editor: {
    fontSize: number;
    tabSize: TabSize;
  };
  ai: {
    providers: AiProvider[];
  };
}

export const DEFAULT_SETTINGS: OsheepSettings = {
  editor: { fontSize: 14, tabSize: 2 },
  ai: { providers: [] },
};

export function newProviderId(): string {
  return "prov_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function sanitizeProvider(raw: unknown): AiProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AiProvider> & { models?: unknown };
  const id = typeof r.id === "string" && r.id ? r.id : newProviderId();
  const name = typeof r.name === "string" ? r.name : "";
  const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl : "";
  const apiKey = typeof r.apiKey === "string" ? r.apiKey : "";
  let models: string[] = [];
  if (Array.isArray(r.models)) {
    models = r.models.filter((m): m is string => typeof m === "string");
  }
  return { id, name, baseUrl, apiKey, models };
}

export function mergeSettings(partial: unknown): OsheepSettings {
  const p = (partial ?? {}) as {
    editor?: { fontSize?: unknown; tabSize?: unknown };
    ai?: { providers?: unknown };
  };
  const fontSize =
    typeof p.editor?.fontSize === "number" &&
    p.editor.fontSize >= 8 &&
    p.editor.fontSize <= 64
      ? p.editor.fontSize
      : DEFAULT_SETTINGS.editor.fontSize;
  const tabSize: TabSize = p.editor?.tabSize === 4 ? 4 : 2;
  const providers: AiProvider[] = Array.isArray(p.ai?.providers)
    ? (p.ai!.providers as unknown[])
        .map(sanitizeProvider)
        .filter((x): x is AiProvider => x !== null)
    : [];
  return {
    editor: { fontSize, tabSize },
    ai: { providers },
  };
}
