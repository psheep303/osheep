# osheep

osheep is a local web IDE/workbench with a Fastify backend and a React/Vite frontend.

## Project Layout

- `backend/` - Fastify API server for workspaces, files, terminals, Git, search, and AI chat.
- `frontend/` - React workbench UI built with Vite.
- `.osheep/docs/` - Product, frontend, backend, and AI design notes.
- `.osheep/plan/` - Project planning notes.
- `docs/reports/` - Archived implementation notes and fix reports.
- `tools/manual-tests/` - Ad hoc verification scripts kept outside the project root.

## Development

Use the root launcher on Windows:

```powershell
.\dev.ps1
```

For built-in workflow template authoring, use the developer launcher:

```powershell
.\dev-developer.cmd
```

Developer mode enables saving workflows as built-in templates and editing,
re-iconing, or deleting system templates. Shipped system template assets live
under `backend/template-library/system/`; the runtime system/user library and
copied icon files live outside workspaces under `~/.osheep/templates/`.

Or run each side directly:

```powershell
cd backend
npm install
npm run dev
```

```powershell
cd frontend
npm install
npm run dev
```

Default local URLs:

- Backend: `http://127.0.0.1:4178`
- Frontend: `http://127.0.0.1:5173`

## Windows Desktop

The Windows application uses a Tauri/WebView2 shell and keeps the existing Node
backend as a bundled sidecar. It does not bundle Chromium, Codex, Claude Code,
Git, or Docker.

The desktop workspace picker selects a local `workspaces` root. Each direct
child folder is a workspace, and the `+` action creates a new child folder in
that root. The selected root is persisted by the local sidecar and continues
to use the same HTTP/WebSocket workspace APIs as remote deployments.

After installing Rust and Visual Studio 2022 Build Tools with the C++ desktop
workload, run:

```powershell
.\desktop-dev.cmd
```

Build the per-user NSIS installer with:

```powershell
.\desktop-build.cmd
```

See [`desktop/README.md`](desktop/README.md) for prerequisites, packaging, logs,
runtime data, and remote mode.

## Verification

```powershell
cd backend
npm run build
```

```powershell
cd frontend
npm run build
```

## Notes

- Keep real API keys in local environment or private tool config only.
- `.claude/`, logs, captured JSONL sessions, build outputs, dependencies, and runtime workspaces are ignored by Git.
