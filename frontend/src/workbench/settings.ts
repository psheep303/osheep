export type TabSize = 2 | 4;

export type AiProviderKind = "codex-cli" | "claude-cli";

export interface AiProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  models: string[];
}

export const DEFAULT_CLI_PROVIDER: AiProvider = {
  id: "cli",
  name: "CLI",
  kind: "codex-cli",
  models: ["default"],
};

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
    autoAllow: AiAutoAllow;
  };
}

export const DEFAULT_AUTO_ALLOW: AiAutoAllow = {
  read: true,
  write: false,
  runNetwork: true,
  runInstall: true,
  runGit: true,
  runTest: true,
  runOther: true,
};

export const DEFAULT_SETTINGS: OsheepSettings = {
  editor: { fontSize: 14, tabSize: 2 },
  ai: {
    autoAllow: { ...DEFAULT_AUTO_ALLOW },
  },
};

export function isCliProviderKind(kind: unknown): kind is AiProviderKind {
  return kind === "codex-cli" || kind === "claude-cli";
}

function sanitizeAutoAllow(raw: unknown): AiAutoAllow {
  const r = (raw ?? {}) as Partial<AiAutoAllow> & { run?: unknown };
  // Back-compat: an old setting with `run: true` should expand to all run-*
  // categories being true. `run: false` (or absent) keeps the new defaults.
  const legacyRun = typeof r.run === "boolean" ? r.run : null;
  const pick = (key: keyof AiAutoAllow, fallback: boolean, legacy: boolean | null) =>
    typeof r[key] === "boolean" ? (r[key] as boolean) : (legacy ?? fallback);
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

export function mergeSettings(partial: unknown): OsheepSettings {
  const p = (partial ?? {}) as {
    editor?: { fontSize?: unknown; tabSize?: unknown };
    ai?: {
      autoAllow?: unknown;
    };
  };
  const fontSize =
    typeof p.editor?.fontSize === "number" && p.editor.fontSize >= 8 && p.editor.fontSize <= 64
      ? p.editor.fontSize
      : DEFAULT_SETTINGS.editor.fontSize;
  const tabSize: TabSize = p.editor?.tabSize === 4 ? 4 : 2;
  const autoAllow = sanitizeAutoAllow(p.ai?.autoAllow);
  return {
    editor: { fontSize, tabSize },
    ai: {
      autoAllow,
    },
  };
}

export type ReasoningKind = "cli";

export function detectReasoningKind(_kind: AiProviderKind, _model: string): ReasoningKind | null {
  return null;
}

export function effortLevels(_rk: ReasoningKind): ReasoningEffort[] {
  return ["off", "low", "medium", "high"];
}
