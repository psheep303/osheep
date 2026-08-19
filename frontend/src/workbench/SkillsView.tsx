import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiClientError,
  getSkills,
  installSkillApi,
  searchSkillsLibrary,
  uninstallSkillApi,
  type InstalledSkill,
  type SkillAgent,
  type SkillsLibraryItem,
  type SkillsSnapshot,
} from "./api";
import { useUiPreferences } from "../i18n/UiPreferences";
import { useOsheepOverlay } from "./OsheepOverlay";

interface SkillsViewProps {
  agent: SkillAgent;
}

export function SkillsView({ agent }: SkillsViewProps) {
  const { t } = useUiPreferences();
  const { confirm, notify } = useOsheepOverlay();
  const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null);
  const [library, setLibrary] = useState<SkillsLibraryItem[]>([]);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [skill, setSkill] = useState("");
  const [agents, setAgents] = useState<SkillAgent[]>([agent]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const lastNotifiedError = useRef<string | null>(null);

  const reportError = (reason: unknown) => {
    const rawMessage = reason instanceof Error ? reason.message : String(reason);
    const yamlDetail = rawMessage.match(/YAML parse error:\s*(.+)$/i)?.[1];
    const message =
      reason instanceof ApiClientError && reason.code === "SKILL_COMMAND_FAILED" && yamlDetail
        ? t("skills.invalidYaml", { detail: yamlDetail })
        : rawMessage;
    if (lastNotifiedError.current !== message) {
      lastNotifiedError.current = message;
      notify.error(message);
    }
  };

  const load = async () => {
    setLoading(true);
    const [localResult, libraryResult] = await Promise.allSettled([
      getSkills(),
      searchSkillsLibrary(query),
    ]);
    if (localResult.status === "fulfilled") setSnapshot(localResult.value);
    else reportError(localResult.reason);
    if (libraryResult.status === "fulfilled") setLibrary(libraryResult.value);
    else reportError(libraryResult.reason);
    if (localResult.status === "fulfilled" && libraryResult.status === "fulfilled") {
      lastNotifiedError.current = null;
    }
    setLoading(false);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => setAgents([agent]), [agent]);

  const installed = useMemo(
    () => snapshot?.installed.filter((item) => item.agents.includes(agent)) ?? [],
    [snapshot, agent],
  );

  const toggleAgent = (value: SkillAgent) => {
    setAgents((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  const install = async (item?: SkillsLibraryItem) => {
    const nextSource = item?.url || item?.source || source.trim();
    const nextSkill = item?.name || skill.trim();
    if (!nextSource) return;
    setBusy(`install:${nextSkill}`);
    try {
      const next = await installSkillApi({ source: nextSource, skill: nextSkill || undefined, agents });
      setSnapshot(next);
      setSource("");
      setSkill("");
      notify.success(t("skills.installSuccess", { name: nextSkill || nextSource }));
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (item: InstalledSkill) => {
    const confirmed = await confirm({
      message: t("skills.confirmUninstall", { name: item.name }),
      confirmLabel: t("skills.uninstall"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(`remove:${item.name}`);
    try {
      setSnapshot(await uninstallSkillApi(item.name, [agent]));
      notify.success(t("skills.uninstallSuccess", { name: item.name }));
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="skills-view side-view">
      <div className="side-view__header skills-view__header">
        <span className="side-view__title">{t("skills.title")}</span>
        <button className="settings-view__icon-button" type="button" onClick={() => void load()} disabled={loading} title={t("common.refresh")} aria-label={t("common.refresh")}>
          <span className={`codicon codicon-refresh${loading ? " skills-view__spin" : ""}`} />
        </button>
      </div>
      <div className="skills-view__intro">{t("skills.description")}</div>

      <div className="skills-view__form">
        <div className="skills-view__form-title">{t("skills.installCustom")}</div>
        <input className="settings-view__input" value={source} onChange={(event) => setSource(event.target.value)} placeholder={t("skills.sourcePlaceholder")} />
        <input className="settings-view__input" value={skill} onChange={(event) => setSkill(event.target.value)} placeholder={t("skills.namePlaceholder")} />
        <div className="skills-view__agents" role="group" aria-label={t("skills.agents")}>
          {(["claude", "codex"] as const).map((value) => (
            <label key={value} className="skills-view__agent">
              <input type="checkbox" checked={agents.includes(value)} onChange={() => toggleAgent(value)} />
              {value === "claude" ? "Claude" : "Codex"}
            </label>
          ))}
        </div>
        <button className="primary-btn" type="button" onClick={() => void install()} disabled={!source.trim() || agents.length === 0 || busy !== null}>
          {busy?.startsWith("install:") ? t("skills.installing") : t("skills.install")}
        </button>
      </div>

      <section className="skills-view__section">
        <div className="skills-view__section-heading"><span>{t("skills.installed")}</span><span>{installed.length}</span></div>
        <div className="skills-view__list">
          {loading && !snapshot ? <div className="skills-view__empty">{t("common.loading")}</div> : installed.length === 0 ? <div className="skills-view__empty">{t("skills.empty")}</div> : installed.map((item) => (
            <div className="skills-view__card" key={`${item.path}:${item.name}`}>
              <div className="skills-view__card-main"><div className="skills-view__name">{item.name}</div><div className="skills-view__agents-label">{item.agents.join(" / ")}</div></div>
              {item.description && <div className="skills-view__description">{item.description}</div>}
              <div className="skills-view__path" title={item.path}>{item.path}</div>
              <button className="tb-btn skills-view__remove" type="button" onClick={() => void uninstall(item)} disabled={busy !== null}>{busy === `remove:${item.name}` ? t("skills.uninstalling") : t("skills.uninstall")}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="skills-view__section skills-view__library">
        <div className="skills-view__section-heading"><span>{t("skills.library")}</span><span>skills.sh</span></div>
        <div className="codex-plugins__search"><span className="codicon codicon-search" /><input className="codex-plugins__search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.searchPlaceholder")} /></div>
        <div className="skills-view__list">
          {library.length === 0 ? <div className="skills-view__empty">{t("skills.libraryEmpty")}</div> : library.map((item) => (
            <div className="skills-view__card" key={`${item.owner ?? ""}/${item.repo ?? ""}/${item.name}`}>
              <div className="skills-view__card-main"><div className="skills-view__name">{item.name}</div><div className="skills-view__installs">{t("skills.installCount", { count: item.installCount.toLocaleString() })}</div></div>
              {(item.owner || item.repo) && <div className="skills-view__repo">{item.owner}{item.owner && item.repo ? "/" : ""}{item.repo}</div>}
              {item.description && <div className="skills-view__description">{item.description}</div>}
              <button className="tb-btn" type="button" onClick={() => void install(item)} disabled={busy !== null}>{busy === `install:${item.name}` ? t("skills.installing") : t("skills.install")}</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
