import { useEffect, useMemo, useState } from "react";
import {
  addClaudeMarketplaceApi,
  disableClaudePluginApi,
  enableClaudePluginApi,
  getClaudePlugins,
  installClaudePluginApi,
  uninstallClaudePluginApi,
  type ClaudePluginRecord,
  type ClaudePluginSnapshot,
} from "./api";

type DialogMode = "marketplace" | null;

export function ClaudePluginsView() {
  const [snapshot, setSnapshot] = useState<ClaudePluginSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [source, setSource] = useState("");

  useEffect(() => {
    void refresh();
  }, []);

  const groups = useMemo(
    () => groupPlugins(snapshot?.plugins ?? []),
    [snapshot]
  );

  async function refresh() {
    await run(async () => {
      setSnapshot(await getClaudePlugins());
    }, false);
  }

  async function run(task: () => Promise<void>, done = true) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await task();
      if (done) {
        setMessage("Restart Claude sessions for plugin changes to take effect.");
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
    setSource("");
    setError(null);
    setMessage(null);
  }

  function install(plugin: ClaudePluginRecord) {
    void run(async () => {
      setSnapshot(await installClaudePluginApi(plugin.selector));
    });
  }

  function uninstall(plugin: ClaudePluginRecord) {
    if (!confirm(`Uninstall ${plugin.displayName}?`)) return;
    void run(async () => {
      setSnapshot(await uninstallClaudePluginApi(plugin.selector));
    });
  }

  function toggleEnabled(plugin: ClaudePluginRecord) {
    void run(async () => {
      setSnapshot(
        plugin.status.enabled
          ? await disableClaudePluginApi(plugin.selector)
          : await enableClaudePluginApi(plugin.selector)
      );
    });
  }

  function submitDialog() {
    if (dialog === "marketplace") {
      void run(async () => {
        setSnapshot(await addClaudeMarketplaceApi(source));
        resetDialog(null);
      });
    }
  }

  return (
    <div className="codex-plugins side-view">
      <div className="side-view__header codex-plugins__header">
        <span className="side-view__title">Claude Plugins</span>
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
        <button
          className="tb-btn"
          onClick={() => resetDialog("marketplace")}
          disabled={busy}
        >
          Source
        </button>
      </div>

      {snapshot && (
        <div className="codex-plugins__path" title={snapshot.paths.marketplaces}>
          {snapshot.paths.marketplaces}
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
          <input
            className="settings-view__input codex-plugins__input"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Marketplace source"
          />
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
        <PluginGroup
          title="Installed"
          plugins={groups.installed}
          busy={busy}
          onInstall={install}
          onUninstall={uninstall}
          onToggleEnabled={toggleEnabled}
        />
        <PluginGroup
          title="Available"
          plugins={groups.available}
          busy={busy}
          onInstall={install}
          onUninstall={uninstall}
          onToggleEnabled={toggleEnabled}
        />
      </div>
    </div>
  );
}

function groupPlugins(plugins: ClaudePluginRecord[]) {
  const installed = plugins.filter((plugin) => plugin.status.installed);
  const installedSelectors = new Set(installed.map((plugin) => plugin.selector));
  const available = plugins.filter(
    (plugin) => plugin.status.available && !installedSelectors.has(plugin.selector)
  );
  return { installed, available };
}

function PluginGroup({
  title,
  plugins,
  busy,
  onInstall,
  onUninstall,
  onToggleEnabled,
}: {
  title: string;
  plugins: ClaudePluginRecord[];
  busy: boolean;
  onInstall: (plugin: ClaudePluginRecord) => void;
  onUninstall: (plugin: ClaudePluginRecord) => void;
  onToggleEnabled: (plugin: ClaudePluginRecord) => void;
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
            onInstall={() => onInstall(plugin)}
            onUninstall={() => onUninstall(plugin)}
            onToggleEnabled={() => onToggleEnabled(plugin)}
          />
        ))
      )}
    </section>
  );
}

function PluginCard({
  plugin,
  busy,
  onInstall,
  onUninstall,
  onToggleEnabled,
}: {
  plugin: ClaudePluginRecord;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onToggleEnabled: () => void;
}) {
  const canInstall = plugin.status.available && !plugin.status.installed;
  const canUninstall = plugin.status.installed;

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
            {plugin.scope && <span>{plugin.scope}</span>}
            {plugin.status.installed && <span>installed</span>}
            {plugin.status.installed && (
              <span>{plugin.status.enabled ? "enabled" : "disabled"}</span>
            )}
            {plugin.status.cached && <span>cached</span>}
            {plugin.installCount !== undefined && (
              <span>{plugin.installCount.toLocaleString()} installs</span>
            )}
          </div>
        </div>
      </div>
      <div className="codex-plugins__actions">
        {canInstall && (
          <button className="tb-btn" onClick={onInstall} disabled={busy}>
            Install
          </button>
        )}
        {canUninstall && (
          <button className="tb-btn" onClick={onToggleEnabled} disabled={busy}>
            {plugin.status.enabled ? "Disable" : "Enable"}
          </button>
        )}
        {canUninstall && (
          <button className="tb-btn" onClick={onUninstall} disabled={busy}>
            Uninstall
          </button>
        )}
      </div>
    </div>
  );
}

function PluginIcon({ plugin }: { plugin: ClaudePluginRecord }) {
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
