import { useEffect, useMemo, useState } from "react";
import {
  addCodexMarketplaceApi,
  createLocalCodexPluginApi,
  getCodexPlugins,
  importLocalCodexPluginApi,
  installCodexPluginApi,
  removeLocalCodexPluginApi,
  uninstallCodexPluginApi,
  type CodexPluginRecord,
  type CodexPluginSnapshot,
} from "./api";

type DialogMode = "new" | "import" | "marketplace" | null;

export function CodexPluginsView() {
  const [snapshot, setSnapshot] = useState<CodexPluginSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [pluginPath, setPluginPath] = useState("");
  const [source, setSource] = useState("");
  const [searchText, setSearchText] = useState("");

  useEffect(() => {
    void refresh();
  }, []);

  const groups = useMemo(
    () => groupPlugins(snapshot?.plugins ?? []),
    [snapshot]
  );
  const filteredGroups = useMemo(
    () => filterGroups(groups, searchText),
    [groups, searchText]
  );
  const hasVisiblePlugins =
    filteredGroups.installed.length +
      filteredGroups.available.length +
      filteredGroups.local.length >
    0;

  async function refresh() {
    await run(async () => {
      setSnapshot(await getCodexPlugins());
    }, false);
  }

  async function run(task: () => Promise<void>, done = true) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await task();
      if (done) {
        setMessage("Restart Codex sessions for plugin changes to take effect.");
        window.setTimeout(() => setMessage(null), 4000);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function resetDialog(next: DialogMode) {
    setDialog(next);
    setName("");
    setDisplayName("");
    setDescription("");
    setPluginPath("");
    setSource("");
    setError(null);
    setMessage(null);
  }

  function install(plugin: CodexPluginRecord) {
    void run(async () => {
      setSnapshot(await installCodexPluginApi(plugin.selector));
    });
  }

  function uninstall(plugin: CodexPluginRecord) {
    if (!confirm(`Uninstall ${plugin.displayName}?`)) return;
    void run(async () => {
      setSnapshot(await uninstallCodexPluginApi(plugin.selector));
    });
  }

  function removeLocal(plugin: CodexPluginRecord, deleteSource: boolean) {
    if (deleteSource) {
      const sourcePath = plugin.source.path ?? "(unknown source path)";
      const typed = prompt(
        `Delete source directory for ${plugin.displayName}?\n\n${sourcePath}\n\nType ${plugin.name} to confirm.`
      );
      if (typed !== plugin.name) return;
    } else if (!confirm(`Remove ${plugin.displayName} from the personal marketplace?`)) {
        return;
    }
    void run(async () => {
      setSnapshot(await removeLocalCodexPluginApi(plugin.name, deleteSource));
    });
  }

  function submitDialog() {
    if (dialog === "new") {
      void run(async () => {
        setSnapshot(await createLocalCodexPluginApi({
          name,
          displayName,
          description,
        }));
        resetDialog(null);
      });
      return;
    }
    if (dialog === "import") {
      void run(async () => {
        setSnapshot(await importLocalCodexPluginApi(pluginPath));
        resetDialog(null);
      });
      return;
    }
    if (dialog === "marketplace") {
      void run(async () => {
        setSnapshot(await addCodexMarketplaceApi(source));
        resetDialog(null);
      });
    }
  }

  return (
    <div className="codex-plugins side-view">
      <div className="side-view__header codex-plugins__header">
        <span className="side-view__title">Codex Plugins</span>
        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => void refresh()}
          disabled={busy}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="codex-plugins__toolbar">
        <button className="primary-btn" onClick={() => resetDialog("new")} disabled={busy}>
          New
        </button>
        <button className="tb-btn" onClick={() => resetDialog("import")} disabled={busy}>
          Import
        </button>
        <button className="tb-btn" onClick={() => resetDialog("marketplace")} disabled={busy}>
          Source
        </button>
      </div>

      <div className="codex-plugins__search">
        <SearchIcon />
        <input
          className="codex-plugins__search-input"
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search plugins"
          aria-label="Search plugins"
          spellCheck={false}
        />
      </div>

      {snapshot && (
        <div className="codex-plugins__path" title={snapshot.paths.personalMarketplace}>
          {snapshot.paths.personalMarketplace}
        </div>
      )}

      {error && (
        <div className="codex-plugins__banner codex-plugins__banner--error">
          {error}
        </div>
      )}
      {message && (
        <div className="codex-plugins__banner codex-plugins__banner--success">
          {message}
        </div>
      )}
      {snapshot?.warnings.map((warning) => (
        <div key={warning} className="codex-plugins__banner codex-plugins__banner--warn">
          {warning}
        </div>
      ))}

      {dialog && (
        <div className="codex-plugins__form">
          {dialog === "new" && (
            <>
              <input
                className="settings-view__input codex-plugins__input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Plugin name"
              />
              <input
                className="settings-view__input codex-plugins__input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
              />
              <textarea
                className="codex-plugins__textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
              />
            </>
          )}
          {dialog === "import" && (
            <input
              className="settings-view__input codex-plugins__input"
              value={pluginPath}
              onChange={(e) => setPluginPath(e.target.value)}
              placeholder="Existing plugin path"
            />
          )}
          {dialog === "marketplace" && (
            <input
              className="settings-view__input codex-plugins__input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Marketplace source"
            />
          )}
          <div className="codex-plugins__form-actions">
            <button className="primary-btn" onClick={submitDialog} disabled={busy}>
              Save
            </button>
            <button className="tb-btn" onClick={() => resetDialog(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="codex-plugins__list">
        {!snapshot && <div className="codex-plugins__empty">Loading...</div>}
        {snapshot && searchText.trim() && !hasVisiblePlugins ? (
          <div className="codex-plugins__empty">No matching plugins</div>
        ) : (
          <>
            <PluginGroup
              title="Installed"
              plugins={filteredGroups.installed}
              busy={busy}
              personalPluginRoot={snapshot?.paths.personalPluginRoot ?? ""}
              onInstall={install}
              onUninstall={uninstall}
              onRemoveLocal={removeLocal}
            />
            <PluginGroup
              title="Available"
              plugins={filteredGroups.available}
              busy={busy}
              personalPluginRoot={snapshot?.paths.personalPluginRoot ?? ""}
              onInstall={install}
              onUninstall={uninstall}
              onRemoveLocal={removeLocal}
            />
            <PluginGroup
              title="Local"
              plugins={filteredGroups.local}
              busy={busy}
              personalPluginRoot={snapshot?.paths.personalPluginRoot ?? ""}
              onInstall={install}
              onUninstall={uninstall}
              onRemoveLocal={removeLocal}
            />
          </>
        )}
      </div>
    </div>
  );
}

function groupPlugins(plugins: CodexPluginRecord[]) {
  const installed = plugins.filter((plugin) => isInstalled(plugin));
  const installedSelectors = new Set(installed.map((plugin) => plugin.selector));
  const local = plugins.filter(
    (plugin) => plugin.status.local && !installedSelectors.has(plugin.selector)
  );
  const localSelectors = new Set(local.map((plugin) => plugin.selector));
  const available = plugins.filter(
    (plugin) =>
      plugin.status.available &&
      !installedSelectors.has(plugin.selector) &&
      !localSelectors.has(plugin.selector)
  );
  return { installed, available, local };
}

function filterGroups(groups: ReturnType<typeof groupPlugins>, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return groups;
  return {
    installed: groups.installed.filter((plugin) =>
      matchesCodexPluginSearch(plugin, normalized)
    ),
    available: groups.available.filter((plugin) =>
      matchesCodexPluginSearch(plugin, normalized)
    ),
    local: groups.local.filter((plugin) =>
      matchesCodexPluginSearch(plugin, normalized)
    ),
  };
}

function matchesCodexPluginSearch(plugin: CodexPluginRecord, query: string): boolean {
  const haystack = [
    plugin.name,
    plugin.marketplace,
    plugin.selector,
    plugin.displayName,
    plugin.version,
    plugin.description,
    plugin.source.path,
    plugin.status.installed ? "installed" : "",
    plugin.status.available ? "available" : "",
    plugin.status.enabled ? "enabled" : "",
    plugin.status.cached ? "cached" : "",
    plugin.status.local ? "local" : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function isInstalled(plugin: CodexPluginRecord): boolean {
  return plugin.status.installed || plugin.status.enabled || plugin.status.cached;
}

function PluginGroup({
  title,
  plugins,
  busy,
  personalPluginRoot,
  onInstall,
  onUninstall,
  onRemoveLocal,
}: {
  title: string;
  plugins: CodexPluginRecord[];
  busy: boolean;
  personalPluginRoot: string;
  onInstall: (plugin: CodexPluginRecord) => void;
  onUninstall: (plugin: CodexPluginRecord) => void;
  onRemoveLocal: (plugin: CodexPluginRecord, deleteSource: boolean) => void;
}) {
  return (
    <section className="codex-plugins__group">
      <div className="codex-plugins__group-title">
        <span>{title}</span>
        <span>{plugins.length}</span>
      </div>
      {plugins.length === 0 ? (
        <div className="codex-plugins__empty">None</div>
      ) : (
        plugins.map((plugin) => (
          <PluginCard
            key={`${title}:${plugin.selector}`}
            plugin={plugin}
            busy={busy}
            canDeleteSource={canDeletePersonalSource(plugin, personalPluginRoot)}
            onInstall={() => onInstall(plugin)}
            onUninstall={() => onUninstall(plugin)}
            onRemoveEntry={() => onRemoveLocal(plugin, false)}
            onDeleteSource={() => onRemoveLocal(plugin, true)}
          />
        ))
      )}
    </section>
  );
}

function PluginCard({
  plugin,
  busy,
  canDeleteSource,
  onInstall,
  onUninstall,
  onRemoveEntry,
  onDeleteSource,
}: {
  plugin: CodexPluginRecord;
  busy: boolean;
  canDeleteSource: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onRemoveEntry: () => void;
  onDeleteSource: () => void;
}) {
  const canInstall = plugin.status.available || plugin.status.local;
  const canUninstall = isInstalled(plugin);

  return (
    <div className="codex-plugins__card">
      <div className="codex-plugins__card-main">
        <PluginIcon plugin={plugin} />
        <div className="codex-plugins__meta">
          <div className="codex-plugins__name">{plugin.displayName}</div>
          <div className="codex-plugins__selector">{plugin.selector}</div>
          {plugin.description && (
            <div className="codex-plugins__desc">{plugin.description}</div>
          )}
          {plugin.source.path && (
            <div className="codex-plugins__source" title={plugin.source.path}>
              {plugin.source.path}
            </div>
          )}
          <div className="codex-plugins__badges">
            {plugin.version && <span>{plugin.version}</span>}
            {plugin.status.installed && <span>installed</span>}
            {plugin.status.enabled && <span>enabled</span>}
            {plugin.status.cached && <span>cached</span>}
            {plugin.status.local && <span>local</span>}
          </div>
        </div>
      </div>
      <div className="codex-plugins__actions">
        {canInstall && !canUninstall && (
          <button className="tb-btn" onClick={onInstall} disabled={busy}>
            Install
          </button>
        )}
        {canUninstall && (
          <button className="tb-btn" onClick={onUninstall} disabled={busy}>
            Uninstall
          </button>
        )}
        {plugin.status.local && (
          <button className="tb-btn" onClick={onRemoveEntry} disabled={busy}>
            Remove
          </button>
        )}
        {canDeleteSource && (
          <button
            className="tb-btn codex-plugins__danger"
            onClick={onDeleteSource}
            disabled={busy}
          >
            Delete Source
          </button>
        )}
      </div>
    </div>
  );
}

function PluginIcon({ plugin }: { plugin: CodexPluginRecord }) {
  const [failed, setFailed] = useState(false);
  const icon = plugin.icon && !failed ? plugin.icon : "";
  const fallbackStyle =
    !icon && plugin.iconColor ? { background: plugin.iconColor } : undefined;

  useEffect(() => {
    setFailed(false);
  }, [plugin.icon]);

  return (
    <div
      className={
        "codex-plugins__avatar" +
        (icon ? " codex-plugins__avatar--image" : "")
      }
      style={fallbackStyle}
      title={plugin.displayName}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          aria-hidden="true"
          onError={() => setFailed(true)}
        />
      ) : (
        plugin.displayName.slice(0, 1).toUpperCase()
      )}
    </div>
  );
}

function canDeletePersonalSource(
  plugin: CodexPluginRecord,
  personalPluginRoot: string
): boolean {
  if (!plugin.status.local || !plugin.source.path || !personalPluginRoot) {
    return false;
  }
  const source = normalizeFilePath(plugin.source.path);
  const expected = normalizeFilePath(`${personalPluginRoot}/${plugin.name}`);
  return source.toLowerCase() === expected.toLowerCase();
}

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
      <path
        d="M10.5 10.5L14 14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 3v4H9" />
      <path d="M3 13V9h4" />
      <path d="M12.2 6A4.5 4.5 0 0 0 4.5 4.8L3 6" />
      <path d="M3.8 10A4.5 4.5 0 0 0 11.5 11.2L13 10" />
    </svg>
  );
}
