import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiClientError,
  deleteSkillApi,
  disableSkillApi,
  enableSkillApi,
  getSkills,
  installSkillApi,
  searchSkillsLibrary,
  type InstalledSkill,
  type SkillAgent,
  type SkillsLibraryItem,
  type SkillsSnapshot,
  type StagedSkill,
} from "./api";
import { hideInstalledFromLibrary, nextOpenGroup, type SkillGroup } from "./skills-view-behavior";
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<SkillGroup | null>("user");
  const [manualSource, setManualSource] = useState("");
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

  const enabled = useMemo(
    () => snapshot?.enabled.filter((item) => item.agents.includes(agent)) ?? [],
    [snapshot, agent],
  );
  const staged = useMemo(
    () => snapshot?.user.filter((item) => item.agent === agent) ?? [],
    [snapshot, agent],
  );
  const installedNames = useMemo(
    () => new Set<string>([...enabled.map((item) => item.name), ...staged.map((item) => item.name)]),
    [enabled, staged],
  );
  const availableLibrary = useMemo(
    () => hideInstalledFromLibrary(library, installedNames),
    [library, installedNames],
  );

  const toggleGroup = (group: SkillGroup) => setOpenGroup((current) => nextOpenGroup(current, group));

  const run = async (key: string, action: () => Promise<SkillsSnapshot>, success: string) => {
    setBusy(key);
    try {
      setSnapshot(await action());
      notify.success(success);
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(null);
    }
  };

  const install = (item: SkillsLibraryItem) => {
    const source = item.url || item.source;
    if (!source) return;
    return run(
      `install:${item.name}`,
      () => installSkillApi({ source, skill: item.name, agent, origin: "skills.sh" }),
      t("skills.installSuccess", { name: item.name }),
    );
  };

  const addManual = async () => {
    const source = manualSource.trim();
    if (!source) return;
    await run("manual", () => installSkillApi({ source, agent, origin: "manual" }), t("skills.installSuccess", { name: source }));
    setManualSource("");
  };

  const enable = (item: StagedSkill) =>
    run(`enable:${item.name}`, () => enableSkillApi(item.name, agent), t("skills.enableSuccess", { name: item.name }));

  const remove = async (item: StagedSkill) => {
    const confirmed = await confirm({
      message: t("skills.confirmDelete", { name: item.name }),
      confirmLabel: t("skills.delete"),
      destructive: true,
    });
    if (!confirmed) return;
    await run(`delete:${item.name}`, () => deleteSkillApi(item.name, agent), t("skills.deleteSuccess", { name: item.name }));
  };

  const disable = async (item: InstalledSkill) => {
    const confirmed = await confirm({
      message: t("skills.confirmDisable", { name: item.name }),
      confirmLabel: t("skills.disable"),
    });
    if (!confirmed) return;
    await run(`disable:${item.name}`, () => disableSkillApi(item.name, agent), t("skills.disableSuccess", { name: item.name }));
  };
  const groupHeader = (group: SkillGroup, label: string, count: number) => (
    <button
      className="skills-view__group-header"
      type="button"
      onClick={() => toggleGroup(group)}
      aria-expanded={openGroup === group}
    >
      <span className={`codicon codicon-chevron-${openGroup === group ? "down" : "right"}`} />
      <span className="skills-view__group-title">{label}</span>
      <span className="skills-view__group-count">{count}</span>
    </button>
  );

  return (
    <div className="skills-view side-view">
      <div className="side-view__header skills-view__header">
        <span className="side-view__title">{t("skills.title")}</span>
        <button className="settings-view__icon-button" type="button" onClick={() => void load()} disabled={loading} title={t("common.refresh")} aria-label={t("common.refresh")}>
          <span className={`codicon codicon-refresh${loading ? " skills-view__spin" : ""}`} />
        </button>
      </div>
      <div className="skills-view__intro">{t("skills.description")}</div>

      <div className="skills-view__scroll">
      <section className="skills-view__group">
        {groupHeader("skills.sh", t("skills.groupLibrary"), availableLibrary.length)}
        {openGroup === "skills.sh" && (
          <div className="skills-view__group-body">
            <div className="codex-plugins__search"><span className="codicon codicon-search" /><input className="codex-plugins__search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.searchPlaceholder")} /></div>
            <div className="skills-view__list">
              {availableLibrary.length === 0 ? <div className="skills-view__empty">{t("skills.libraryEmpty")}</div> : availableLibrary.map((item) => (
                <div className="skills-view__card" key={`${item.owner ?? ""}/${item.repo ?? ""}/${item.name}`}>
                  <div className="skills-view__card-main"><div className="skills-view__name">{item.name}</div><div className="skills-view__installs">{t("skills.installCount", { count: item.installCount.toLocaleString() })}</div></div>
                  {(item.owner || item.repo) && <div className="skills-view__repo">{item.owner}{item.owner && item.repo ? "/" : ""}{item.repo}</div>}
                  {item.description && <div className="skills-view__description">{item.description}</div>}
                  <button className="tb-btn" type="button" onClick={() => void install(item)} disabled={busy !== null || (!item.url && !item.source)}>{busy === `install:${item.name}` ? t("skills.installing") : t("skills.install")}</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="skills-view__group">
        {groupHeader("user", t("skills.groupUser"), staged.length)}
        {openGroup === "user" && (
          <div className="skills-view__group-body">
            <div className="skills-view__manual" title={t("skills.manualAddTitle")}>
              <input className="codex-plugins__search-input" value={manualSource} onChange={(event) => setManualSource(event.target.value)} placeholder={t("skills.manualAddPlaceholder")} />
              <button className="tb-btn" type="button" onClick={() => void addManual()} disabled={busy !== null || manualSource.trim().length === 0}>{busy === "manual" ? t("skills.installing") : t("skills.manualAddSubmit")}</button>
            </div>
            <div className="skills-view__list">
              {loading && !snapshot ? <div className="skills-view__empty">{t("common.loading")}</div> : staged.length === 0 ? <div className="skills-view__empty">{t("skills.emptyUser")}</div> : staged.map((item) => (
                <div className="skills-view__card" key={`${item.path}:${item.name}`}>
                  <div className="skills-view__card-main"><div className="skills-view__name">{item.name}</div><div className="skills-view__installs">{item.origin === "skills.sh" ? t("skills.originLibrary") : t("skills.originManual")}</div></div>
                  {item.description && <div className="skills-view__description">{item.description}</div>}
                  <div className="skills-view__actions">
                    <button className="tb-btn" type="button" onClick={() => void enable(item)} disabled={busy !== null}>{busy === `enable:${item.name}` ? t("skills.enabling") : t("skills.enable")}</button>
                    <button className="tb-btn skills-view__remove" type="button" onClick={() => void remove(item)} disabled={busy !== null}>{busy === `delete:${item.name}` ? t("skills.deleting") : t("skills.delete")}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="skills-view__group">
        {groupHeader("enabled", t("skills.groupEnabled"), enabled.length)}
        {openGroup === "enabled" && (
          <div className="skills-view__group-body">
            <div className="skills-view__list">
              {loading && !snapshot ? <div className="skills-view__empty">{t("common.loading")}</div> : enabled.length === 0 ? <div className="skills-view__empty">{t("skills.emptyEnabled")}</div> : enabled.map((item) => (
                <div className="skills-view__card" key={`${item.path}:${item.name}`}>
                  <div className="skills-view__card-main"><div className="skills-view__name">{item.name}</div><div className="skills-view__agents-label">{item.agents.join(" / ")}</div></div>
                  {item.description && <div className="skills-view__description">{item.description}</div>}
                  <div className="skills-view__path" title={item.path}>{item.path}</div>
                  <button className="tb-btn skills-view__remove" type="button" onClick={() => void disable(item)} disabled={busy !== null}>{busy === `disable:${item.name}` ? t("skills.disabling") : t("skills.disable")}</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      </div>
    </div>
  );
}
