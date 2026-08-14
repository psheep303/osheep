import React from "react";
import ReactDOM from "react-dom/client";
import { applyUiPreferences, readUiPreferences, UiPreferencesProvider } from "./i18n/UiPreferences";
import { Workbench } from "./workbench/Workbench";
import { OsheepOverlayProvider } from "./workbench/OsheepOverlay";
import "@vscode/codicons/dist/codicon.css";
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-600.css";
import "@fontsource/geist-sans/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/geist-mono/latin-600.css";
import "./styles.css";

applyUiPreferences(readUiPreferences());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UiPreferencesProvider>
      <OsheepOverlayProvider>
        <Workbench />
      </OsheepOverlayProvider>
    </UiPreferencesProvider>
  </React.StrictMode>,
);
