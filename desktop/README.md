# osheep Desktop

The desktop application uses the React frontend and a shared Rust service:

```text
Tauri WebView -> shared osheep-server sidecar -> filesystem, PTY, Git, workflows, AI CLIs
```

The Rust service serves the production frontend so HTTP requests and terminal WebSockets
remain same-origin. Multiple windows discover and reuse one local service process.

## Prerequisites

- Node.js (used only to build the frontend and Tauri CLI)
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

The pre-launch hook builds the frontend and `osheep-server`. Tauri then starts or
discovers the shared Rust service on a loopback port and opens it in WebView2.
Service output is written to the Tauri application log directory as `rust-service.log`.

To connect the shell to a remote osheep deployment instead of starting the local
Rust service:

```powershell
.\desktop-dev.cmd -RemoteUrl 'https://osheep.example.com/#osheep-token=YOUR_TOKEN'
```

The remote URL must serve the osheep frontend and `/api` from the same origin. The remote service
must set the same value as `OSHEEP_AUTH_TOKEN`, list the HTTPS origin in `CORS_ORIGIN`, and remain
behind network access controls. The frontend exchanges the fragment token for an HttpOnly session
and removes it from the address bar.

## Windows Installer

After finishing a code change, use this sequence from the repository root:

```powershell
# 1. Verify Rust and frontend
cargo test --workspace --locked
cd frontend
npm.cmd run build
cd ..

# 2. Verify the desktop shell interactively
.\desktop-dev.cmd

# 3. Produce the Windows installer
.\desktop-build.cmd
```

`desktop-build.cmd` builds the frontend and Rust service, stages only those
resources, compiles the Tauri release executable, and runs NSIS. Project caches
are kept under `.cache/`; Rust output and the local NSIS tool cache stay under
`desktop/src-tauri/target/`.

Before publishing a new release, keep these three version fields in sync:

- `desktop/package.json`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/tauri.conf.json`

Then run:

```powershell
.\desktop-build.cmd
```

The release preparation hook:

1. Builds `osheep-server` and the frontend.
2. Copies only the Rust service binary and built frontend into `desktop/stage`.
4. Lets Tauri produce a per-user NSIS installer.

The installer is written under `desktop/src-tauri/target/release/bundle/nsis/`.
`desktop/stage` and Rust build outputs are ignored by Git.

If testing a replacement installer with the same version number, uninstall the
existing osheep installation first so Windows does not retain old resources.

## Runtime Data

Desktop persistent Osheep data lives under the Tauri per-user app data `data`
directory. The default workspaces root is `data/workspaces`; legacy workspaces
and root selection are copied and verified on first startup. WebView caches,
runtime registration, logs, and service state remain in per-user app data.

The existing `~/.codex`, `~/.claude`, `.agents`, and personal plugin locations
remain external because they belong to the underlying CLIs rather than Osheep.
