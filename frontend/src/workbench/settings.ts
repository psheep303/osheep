export type TabSize = 2 | 4;

export type AiProviderKind = "openai" | "anthropic";

export interface AiProvider {
  id: string;
  name: string;
  /**
   * Wire protocol. `openai` = OpenAI-compatible /chat/completions.
   * `anthropic` = Claude API /v1/messages (and Claude Code style endpoints
   * that share the Anthropic wire format).
   */
  kind: AiProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

/**
 * Granular auto-allow categories. `run` got split into network / install /
 * git / test / other so the confirmation prompt can be much less spammy for
 * benign command classes while still gating dangerous ones.
 */
export interface AiAutoAllow {
  read: boolean;
  write: boolean;
  runNetwork: boolean;
  runInstall: boolean;
  runGit: boolean;
  runTest: boolean;
  runOther: boolean;
}

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high";

export interface OsheepSettings {
  editor: {
    fontSize: number;
    tabSize: TabSize;
  };
  ai: {
    providers: AiProvider[];
    autoAllow: AiAutoAllow;
    /**
     * Default (providerId, model) pair the chat composer always uses.
     * Edited from the Settings page OR the slash menu's Model section.
     */
    defaultProviderId?: string;
    defaultModel?: string;
    /**
     * Reasoning effort per (providerId, model) pair. Key format:
     * `${providerId}::${model}`. Only models that support reasoning
     * (gpt-5*, o1*, o3*, o4* for OpenAI; claude-3-7-*, claude-4-*, etc. for
     * Anthropic) honour this; the rest ignore it.
     */
    reasoningEffort?: Record<string, ReasoningEffort>;
    /** @deprecated kept for backward compatibility — read as fallback. */
    lastProviderId?: string;
    /** @deprecated */
    lastModel?: string;
  };
}

export const DEFAULT_AUTO_ALLOW: AiAutoAllow = {
  read: true,
  write: false,
  runNetwork: false,
  runInstall: false,
  runGit: false,
  runTest: false,
  runOther: false,
};

export const DEFAULT_SETTINGS: OsheepSettings = {
  editor: { fontSize: 14, tabSize: 2 },
  ai: {
    providers: [],
    autoAllow: { ...DEFAULT_AUTO_ALLOW },
    reasoningEffort: {},
  },
};

export function newProviderId(): string {
  return "prov_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function sanitizeProvider(raw: unknown): AiProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AiProvider> & { models?: unknown };
  const id = typeof r.id === "string" && r.id ? r.id : newProviderId();
  const name = typeof r.name === "string" ? r.name : "";
  const kind: AiProviderKind = r.kind === "anthropic" ? "anthropic" : "openai";
  const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl : "";
  const apiKey = typeof r.apiKey === "string" ? r.apiKey : "";
  let models: string[] = [];
  if (Array.isArray(r.models)) {
    models = r.models.filter((m): m is string => typeof m === "string");
  }
  return { id, name, kind, baseUrl, apiKey, models };
}

function sanitizeAutoAllow(raw: unknown): AiAutoAllow {
  const r = (raw ?? {}) as Partial<AiAutoAllow> & { run?: unknown };
  // Back-compat: an old setting with `run: true` should expand to all run-*
  // categories being true. `run: false` (or absent) keeps the new defaults.
  const legacyRun = typeof r.run === "boolean" ? r.run : null;
  const pick = (
    key: keyof AiAutoAllow,
    fallback: boolean,
    legacy: boolean | null
  ) => (typeof r[key] === "boolean" ? (r[key] as boolean) : legacy ?? fallback);
  return {
    read: pick("read", DEFAULT_AUTO_ALLOW.read, null),
    write: pick("write", DEFAULT_AUTO_ALLOW.write, null),
    runNetwork: pick("runNetwork", DEFAULT_AUTO_ALLOW.runNetwork, legacyRun),
    runInstall: pick("runInstall", DEFAULT_AUTO_ALLOW.runInstall, legacyRun),
    runGit: pick("runGit", DEFAULT_AUTO_ALLOW.runGit, legacyRun),
    runTest: pick("runTest", DEFAULT_AUTO_ALLOW.runTest, legacyRun),
    runOther: pick("runOther", DEFAULT_AUTO_ALLOW.runOther, legacyRun),
  };
}

function sanitizeReasoningEffort(raw: unknown): Record<string, ReasoningEffort> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ReasoningEffort> = {};
  const allowed: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high"];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !k) continue;
    if (typeof v !== "string") continue;
    if (!allowed.includes(v as ReasoningEffort)) continue;
    out[k] = v as ReasoningEffort;
  }
  return out;
}

export function mergeSettings(partial: unknown): OsheepSettings {
  const p = (partial ?? {}) as {
    editor?: { fontSize?: unknown; tabSize?: unknown };
    ai?: {
      providers?: unknown;
      autoAllow?: unknown;
      defaultProviderId?: unknown;
      defaultModel?: unknown;
      reasoningEffort?: unknown;
      lastProviderId?: unknown;
      lastModel?: unknown;
    };
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
  const autoAllow = sanitizeAutoAllow(p.ai?.autoAllow);
  const defaultProviderId =
    typeof p.ai?.defaultProviderId === "string"
      ? p.ai!.defaultProviderId
      : undefined;
  const defaultModel =
    typeof p.ai?.defaultModel === "string" ? p.ai!.defaultModel : undefined;
  const reasoningEffort = sanitizeReasoningEffort(p.ai?.reasoningEffort);
  const lastProviderId =
    typeof p.ai?.lastProviderId === "string" ? p.ai!.lastProviderId : undefined;
  const lastModel = typeof p.ai?.lastModel === "string" ? p.ai!.lastModel : undefined;
  return {
    editor: { fontSize, tabSize },
    ai: {
      providers,
      autoAllow,
      defaultProviderId,
      defaultModel,
      reasoningEffort,
      lastProviderId,
      lastModel,
    },
  };
}

/**
 * Resolve the (providerId, model) pair the chat composer should use.
 * Order: explicit defaults → legacy last-used → first provider's first model.
 */
export function resolveDefaultProviderModel(
  s: OsheepSettings
): { providerId: string; model: string } {
  const provs = s.ai.providers;
  const tryPair = (pid?: string, m?: string): { providerId: string; model: string } | null => {
    if (!pid || !m) return null;
    const p = provs.find((x) => x.id === pid);
    if (!p) return null;
    if (!p.models.includes(m)) return null;
    return { providerId: pid, model: m };
  };
  return (
    tryPair(s.ai.defaultProviderId, s.ai.defaultModel) ??
    tryPair(s.ai.lastProviderId, s.ai.lastModel) ??
    (provs[0] && provs[0].models[0]
      ? { providerId: provs[0].id, model: provs[0].models[0] }
      : { providerId: "", model: "" })
  );
}

// ─────────────── Reasoning effort helpers ───────────────

/**
 * Returns whether the model supports reasoning effort and (if so) which
 * effort levels make sense for it.
 *
 * OpenAI reasoning models accept `minimal | low | medium | high`.
 * Anthropic extended-thinking models map `off | low | medium | high` to
 * thinking budget tokens on the backend.
 *
 * Non-reasoning models (gpt-4o, claude-3-5-*, …) return `null` — the UI
 * should hide the effort selector for them.
 */
export type ReasoningKind = "openai-reasoning" | "anthropic-thinking";

export function detectReasoningKind(
  kind: AiProviderKind,
  model: string
): ReasoningKind | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (kind === "openai") {
    if (
      m.startsWith("gpt-5") ||
      m.startsWith("o1") ||
      m.startsWith("o3") ||
      m.startsWith("o4")
    ) {
      return "openai-reasoning";
    }
    return null;
  }
  if (kind === "anthropic") {
    if (
      m.startsWith("claude-3-7") ||
      m.startsWith("claude-4") ||
      m.startsWith("claude-opus-4") ||
      m.startsWith("claude-sonnet-4") ||
      m.startsWith("claude-haiku-4")
    ) {
      return "anthropic-thinking";
    }
    return null;
  }
  return null;
}

export function effortLevels(rk: ReasoningKind): ReasoningEffort[] {
  if (rk === "openai-reasoning") return ["minimal", "low", "medium", "high"];
  return ["off", "low", "medium", "high"];
}

export function defaultEffortFor(rk: ReasoningKind): ReasoningEffort {
  return rk === "openai-reasoning" ? "medium" : "low";
}

export function effortKey(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

export function resolveEffort(
  s: OsheepSettings,
  providerId: string,
  model: string,
  kind: AiProviderKind
): ReasoningEffort | null {
  const rk = detectReasoningKind(kind, model);
  if (!rk) return null;
  const map = s.ai.reasoningEffort ?? {};
  const v = map[effortKey(providerId, model)];
  if (v && effortLevels(rk).includes(v)) return v;
  return defaultEffortFor(rk);
}
