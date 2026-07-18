# Codex Plugin Manager Design

## Goal

Add a Codex plugin manager to the left sidebar so osheep can show, install, uninstall, create, import, and remove Codex plugins such as `superpowers@openai-api-curated`.

## Chosen Direction

Use a hybrid backend model:

- Codex CLI commands manage install and uninstall actions.
- Local file inspection fills gaps that the CLI JSON output may not expose.
- Personal plugin creation and import are handled by osheep because they involve local source files and the personal marketplace file.

The backend should call `codex.cmd` on Windows and `codex` on other platforms. PowerShell `codex.ps1` should not be used because Windows execution policy can block it.

## Scope

Create a user-level plugin manager that does not depend on the selected workspace.

Backend changes:

- Add `backend/src/codex-plugins.ts`.
- Add `backend/src/routes/codex-plugins.ts`.
- Register the route module from `backend/src/server.ts`.

Frontend changes:

- Add `codex-plugins` to `frontend/src/workbench/ActivityBar.tsx`.
- Render a new sidebar view from `frontend/src/workbench/Workbench.tsx`.
- Add `frontend/src/workbench/CodexPluginsView.tsx`.
- Add API client functions and types in `frontend/src/workbench/api.ts`.
- Add focused styles in `frontend/src/workbench/workbench.css`.

## Sources And Current Behavior

The local CLI exposes these commands:

- `codex.cmd plugin list --available --json`
- `codex.cmd plugin add <plugin@marketplace> --json`
- `codex.cmd plugin remove <plugin@marketplace> --json`
- `codex.cmd plugin marketplace list --json`
- `codex.cmd plugin marketplace add <source> --json`

The current machine has `superpowers@openai-api-curated` enabled in `~/.codex/config.toml` and cached under `~/.codex/plugins/cache/openai-api-curated/superpowers/...`, even though `codex.cmd plugin list --available --json` currently returns empty installed and available arrays. The manager must therefore merge CLI output with local config and cache scans.

An attempt to fetch the official Codex manual from `https://developers.openai.com/codex/codex-manual.md` returned HTTP 403 on July 4, 2026, so this design is based on verified local CLI behavior and the installed Codex plugin creation rules available in this environment.

## User Experience

The left ActivityBar gets a Codex plugin icon. Selecting it opens the existing left `side-view` area rather than a new editor tab.

The view header includes:

- Title: `Codex Plugins`
- Refresh icon button
- `New` button for creating a personal local plugin
- `Add Source` button for adding a marketplace source or importing an existing local plugin directory

The body groups plugin cards into:

- Installed: plugins installed or enabled in Codex, including config/cache-discovered plugins.
- Available: marketplace plugins that can be installed.
- Local: personal source plugins from `~/plugins` and `~/.agents/plugins/marketplace.json`.

Each card shows display name, selector, version, description, source, and status badges for installed, available, enabled, cached, and local. Actions are shown only when valid:

- Installed plugins can be uninstalled.
- Available plugins can be installed.
- Local plugins can be installed, removed from the personal marketplace, or have their source deleted when safe.

Successful install, uninstall, create, import, and remove actions refresh the list and show a short message that a new Codex session may be required for changed plugins to take effect.

## Backend API

`GET /api/codex-plugins`

Returns a snapshot with paths, marketplaces, plugins, and any non-fatal discovery warnings.

`POST /api/codex-plugins/install`

Body: `{ "selector": "plugin@marketplace" }`

Runs `codex plugin add` through the platform-specific executable.

`POST /api/codex-plugins/uninstall`

Body: `{ "selector": "plugin@marketplace" }`

Runs `codex plugin remove` through the platform-specific executable.

`POST /api/codex-plugins/local`

Body: `{ "name": "my-plugin", "displayName": "My Plugin", "description": "..." }`

Normalizes the plugin name, creates `~/plugins/<name>/.codex-plugin/plugin.json`, and adds or updates the personal marketplace entry in `~/.agents/plugins/marketplace.json`.

`POST /api/codex-plugins/import-local`

Body: `{ "path": "C:/path/to/plugin" }`

Reads the plugin manifest from `<path>/.codex-plugin/plugin.json` and adds a personal marketplace entry pointing at that plugin.

`DELETE /api/codex-plugins/local/:name?deleteSource=true|false`

Removes a plugin entry from the personal marketplace. If `deleteSource=true`, source deletion is allowed only when the resolved source path is exactly under `~/plugins/<name>`.

`POST /api/codex-plugins/marketplaces`

Body: `{ "source": "local path, owner/repo, or git URL" }`

Runs `codex plugin marketplace add <source> --json`.

## Data Model

The frontend receives normalized plugin records:

```ts
interface CodexPluginRecord {
  name: string;
  marketplace?: string;
  selector: string;
  displayName: string;
  version?: string;
  description?: string;
  status: {
    installed: boolean;
    available: boolean;
    enabled: boolean;
    cached: boolean;
    local: boolean;
  };
  source: {
    kind: "marketplace" | "personal" | "cache" | "config";
    path?: string;
  };
}
```

The backend merges records by selector first, then by plugin name for local records without marketplace information. CLI records are enriched with manifest metadata from cache or local source when available.

## Local Files

The manager reads:

- `~/.codex/config.toml`
- `~/.codex/plugins/cache`
- `~/.agents/plugins/marketplace.json`
- `~/plugins`

The manager writes:

- `~/.agents/plugins/marketplace.json`
- `~/plugins/<name>/.codex-plugin/plugin.json`

No workspace files are changed by plugin actions.

## Safety Rules

Plugin names are normalized to lowercase kebab-case and capped at 64 characters.

The backend never deletes files from `~/.codex/plugins/cache` or arbitrary imported plugin paths. It only deletes source when all of these are true:

- The user requested `deleteSource=true`.
- The plugin exists in the personal marketplace.
- The resolved path is under the default personal plugin root.
- The resolved final directory name matches the normalized plugin name.

Official, cached, and non-personal plugins can be uninstalled through the CLI but cannot have source deleted from this UI.

## Error Handling

If the Codex CLI is missing, return a clear `CODEX_CLI_NOT_FOUND` API error.

If CLI output contains a Windows code page banner before JSON, parse from the first `{` or `[` character.

If CLI JSON parsing fails, return the stderr and the first useful stdout excerpt.

If the personal marketplace file is missing, creating or importing a local plugin creates it with marketplace name `personal`, display name `Personal`, and a plugin entry using `policy.installation = AVAILABLE`, `policy.authentication = ON_INSTALL`, and category `Productivity`.

If an imported plugin has no manifest, invalid JSON, or no name, return a validation error without modifying marketplace files.

Discovery failures should not blank the whole view. `GET /api/codex-plugins` should return partial data and warnings where possible.

## Testing And Verification

Backend tests should cover:

- Plugin name normalization.
- JSON parsing with the `Active code page: 65001` prefix.
- Merging CLI, config, cache, personal marketplace, and local plugin records.
- Creating the initial personal marketplace file.
- Adding a local plugin entry.
- Refusing unsafe source deletion outside `~/plugins/<name>`.
- Handling missing Codex CLI as a typed API error.

Frontend verification should use:

- `npm run build` in `frontend/`

Backend verification should use:

- `npm run build` in `backend/`

Manual verification should check:

- `superpowers@openai-api-curated` appears from config/cache discovery.
- A new local plugin appears in the Local group.
- Install and uninstall call the expected API and refresh the snapshot.
- Unsafe delete paths are rejected.
- Sidebar controls fit without text overlap at the default side width.

## Out Of Scope

- Editing plugin skills, MCP server files, hooks, apps, or assets inside the manager.
- A full plugin marketplace browser beyond what configured marketplaces expose.
- Git cloning or package-manager dependency installation outside `codex plugin marketplace add`.
- Enabling or disabling plugins without uninstalling them, unless Codex CLI exposes a dedicated command.
- Managing non-Codex plugins or Vite/frontend plugins.
