# osheep Desktop

The desktop application keeps the existing React and Fastify architecture:

```text
Tauri WebView -> local Fastify sidecar -> filesystem, PTY, Git, workflows, AI CLIs
```

Fastify serves the production frontend so HTTP requests and terminal WebSockets
remain same-origin. Rust only owns the desktop window and the Node child process.

## Prerequisites

- Node.js (used to build and bundled into releases)
- Rust stable (`rustup` and Cargo)
- Visual Studio 2022 Build Tools with "Desktop development with C++"
- Microsoft Edge WebView2 Runtime

Check the machine with:

```powershell
cd desktop
npx tauri info
```

## Development

From the repository root:

```powershell
.\desktop-dev.cmd
```

The pre-launch hook builds the existing frontend and backend. Tauri then starts
the compiled backend on an available loopback port and opens it in WebView2.
Backend output is written to the Tauri application log directory as
`backend.log`.

To connect the shell to a remote osheep deployment instead of starting a local
backend:

```powershell
.\desktop-dev.cmd -RemoteUrl 'https://osheep.example.com/#osheep-token=YOUR_TOKEN'
```

The remote URL must serve the osheep frontend and `/api` from the same origin. The remote backend
must set the same value as `OSHEEP_AUTH_TOKEN`, list the HTTPS origin in `CORS_ORIGIN`, and remain
behind network access controls. The frontend exchanges the fragment token for an HttpOnly session
and removes it from the address bar.

## Windows Installer

After finishing a code change, use this sequence from the repository root:

```powershell
# 1. Verify both TypeScript projects
cd backend
npm.cmd run build
npm.cmd test
cd ..\frontend
npm.cmd run build
cd ..

# 2. Verify the desktop shell interactively
.\desktop-dev.cmd

# 3. Produce the Windows installer
.\desktop-build.cmd
```

`desktop-build.cmd` performs the frontend/backend production builds, creates a
production-only Node sidecar stage, compiles the Tauri release executable, and
runs NSIS. Project caches are kept under `.cache/`; Rust output and the local
NSIS tool cache stay under `desktop/src-tauri/target/`.

Before publishing a new release, keep these three version fields in sync:

- `desktop/package.json`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/tauri.conf.json`

Then run:

```powershell
.\desktop-build.cmd
```

The release preparation hook:

1. Builds the backend and frontend.
2. Installs production-only backend dependencies into `desktop/stage`.
3. Copies the active Node runtime, built frontend, backend, and system templates.
4. Lets Tauri produce a per-user NSIS installer.

The installer is written under `desktop/src-tauri/target/release/bundle/nsis/`.
`desktop/stage` and Rust build outputs are ignored by Git.

If testing a replacement installer with the same version number, uninstall the
existing osheep installation first so Windows does not retain old resources.

Use a supported LTS Node release when producing official installers. The Node
binary is copied from `Get-Command node`; `prepare-release.ps1 -NodeBinary PATH`
can select a dedicated release runtime.

## Runtime Data

Desktop persistent Osheep data lives under the installed
`backend/.osheep` directory. The default workspaces root is
`backend/.osheep/workspaces`; the workspace picker can select another local
root, and that selection is stored in `backend/.osheep/workspace-root.json`.
Legacy workspaces and the root selection are copied from Tauri local app data,
verified, and then removed on first startup. WebView caches, logs, and the
versioned bundled Node runtime remain in Tauri local app data.

The existing `~/.codex`, `~/.claude`, `.agents`, and personal plugin locations
remain external because they belong to the underlying CLIs rather than Osheep.
