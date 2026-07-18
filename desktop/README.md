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
.\desktop-dev.cmd -RemoteUrl https://osheep.example.com
```

The remote URL must serve the osheep frontend and `/api` from the same origin.

## Windows Installer

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

Use a supported LTS Node release when producing official installers. The Node
binary is copied from `Get-Command node`; `prepare-release.ps1 -NodeBinary PATH`
can select a dedicated release runtime.

## Runtime Data

Desktop workspaces live in Tauri's per-user local application data directory,
not in the installation directory. The existing `~/.osheep`, `~/.codex`, and
`~/.claude` locations remain available to the Node backend, so Codex and Claude
Code are discovered from the user's current installation and `PATH`.
