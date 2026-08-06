import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { en, type MessageKey, type MessageParams, zhCN } from "./messages";

export type LanguagePreference = "system" | "zh-CN" | "en";
export type ResolvedLanguage = Exclude<LanguagePreference, "system">;
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export interface UiPreferences {
  language: LanguagePreference;
  theme: ThemePreference;
}

interface UiPreferencesContextValue extends UiPreferences {
  resolvedLanguage: ResolvedLanguage;
  resolvedTheme: ResolvedTheme;
  setLanguage: (language: LanguagePreference) => void;
  setTheme: (theme: ThemePreference) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
}

export const UI_PREFERENCES_STORAGE_KEY = "osheep.uiPreferences.v1";
export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  language: "system",
  theme: "system",
};

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || value === "zh-CN" || value === "en";
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function parseUiPreferences(raw: string | null): UiPreferences {
  if (!raw) return DEFAULT_UI_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      language: isLanguagePreference(value.language) ? value.language : "system",
      theme: isThemePreference(value.theme) ? value.theme : "system",
    };
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

export function resolveSystemLanguage(languages: readonly string[]): ResolvedLanguage {
  return languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
}

export function resolveSystemTheme(prefersDark: boolean): ResolvedTheme {
  return prefersDark ? "dark" : "light";
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return ["en"];
  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  return languages.length > 0 ? languages : [navigator.language || "en"];
}

function browserPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function readUiPreferences(): UiPreferences {
  if (typeof localStorage === "undefined") return DEFAULT_UI_PREFERENCES;
  try {
    return parseUiPreferences(localStorage.getItem(UI_PREFERENCES_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

export function applyUiPreferences(preferences: UiPreferences): {
  language: ResolvedLanguage;
  theme: ResolvedTheme;
} {
  const language =
    preferences.language === "system"
      ? resolveSystemLanguage(browserLanguages())
      : preferences.language;
  const theme =
    preferences.theme === "system" ? resolveSystemTheme(browserPrefersDark()) : preferences.theme;
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
  return { language, theme };
}

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readUiPreferences);
  const [systemLanguage, setSystemLanguage] = useState(() =>
    resolveSystemLanguage(browserLanguages()),
  );
  const [systemTheme, setSystemTheme] = useState(() => resolveSystemTheme(browserPrefersDark()));

  const resolvedLanguage =
    preferences.language === "system" ? systemLanguage : preferences.language;
  const resolvedTheme = preferences.theme === "system" ? systemTheme : preferences.theme;

  useEffect(() => {
    const onLanguageChange = () => setSystemLanguage(resolveSystemLanguage(browserLanguages()));
    window.addEventListener("languagechange", onLanguageChange);
    const colorScheme =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const onColorSchemeChange = (event: MediaQueryListEvent) =>
      setSystemTheme(resolveSystemTheme(event.matches));
    colorScheme?.addEventListener("change", onColorSchemeChange);
    return () => {
      colorScheme?.removeEventListener("change", onColorSchemeChange);
      window.removeEventListener("languagechange", onLanguageChange);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Preferences remain active for this session when storage is unavailable.
    }
  }, [preferences]);

  useEffect(() => {
    document.documentElement.lang = resolvedLanguage;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedLanguage, resolvedTheme]);

  const setLanguage = useCallback((language: LanguagePreference) => {
    setPreferences((current) => ({ ...current, language }));
  }, []);
  const setTheme = useCallback((theme: ThemePreference) => {
    setPreferences((current) => ({ ...current, theme }));
  }, []);

  const t = useCallback(
    (key: MessageKey, params: MessageParams = {}) => {
      const messages = resolvedLanguage === "zh-CN" ? zhCN : en;
      return messages[key].replace(/\{(\w+)\}/g, (match, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    },
    [resolvedLanguage],
  );

  const value = useMemo<UiPreferencesContextValue>(
    () => ({
      ...preferences,
      resolvedLanguage,
      resolvedTheme,
      setLanguage,
      setTheme,
      t,
    }),
    [preferences, resolvedLanguage, resolvedTheme, setLanguage, setTheme, t],
  );

  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferencesContextValue {
  const value = useContext(UiPreferencesContext);
  if (!value) throw new Error("useUiPreferences must be used inside UiPreferencesProvider");
  return value;
}
