import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";

export function DesktopWindowControls() {
  const { t } = useUiPreferences();
  const [maximized, setMaximized] = useState(false);
  const appWindow = useMemo(() => getCurrentWindow(), []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncMaximized = async () => {
      try {
        const next = await appWindow.isMaximized();
        if (!disposed) setMaximized(next);
      } catch (error) {
        console.error("Failed to read window maximized state", error);
      }
    };

    void syncMaximized();
    void appWindow
      .onResized(() => void syncMaximized())
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => console.error("Failed to listen for window resize events", error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow]);

  const runWindowAction = (name: string, action: () => Promise<void>) => {
    void action().catch((error) => console.error(`Failed to ${name} window`, error));
  };

  const toggleMaximized = () => {
    runWindowAction("toggle maximized state for", async () => {
      await appWindow.toggleMaximize();
      setMaximized(await appWindow.isMaximized());
    });
  };

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-controls__button"
        title={t("window.minimize")}
        aria-label={t("window.minimize")}
        onClick={() => runWindowAction("minimize", () => appWindow.minimize())}
      >
        <i className="codicon codicon-chrome-minimize" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-controls__button"
        title={t(maximized ? "window.restore" : "window.maximize")}
        aria-label={t(maximized ? "window.restore" : "window.maximize")}
        onClick={toggleMaximized}
      >
        <i
          className={`codicon codicon-chrome-${maximized ? "restore" : "maximize"}`}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        className="window-controls__button window-controls__button--close"
        title={t("window.close")}
        aria-label={t("window.close")}
        onClick={() => runWindowAction("close", () => appWindow.close())}
      >
        <i className="codicon codicon-chrome-close" aria-hidden="true" />
      </button>
    </div>
  );
}
