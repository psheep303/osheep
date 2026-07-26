# Osheep

[![CI](https://github.com/psheep303/osheep/actions/workflows/ci.yml/badge.svg)](https://github.com/psheep303/osheep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.md)

Osheep is a local development workbench built around AI workflows. It brings code editing, terminals, search, Git, workflow templates, and Codex / Claude Code integration into a single interface, and runs either as a web app or as a Windows desktop app.

> The project is still in early development; APIs, configuration formats, and interactions may change in incompatible ways. Single-machine, single-user scenarios are the current priority — do not expose the backend directly to untrusted networks.

## Features

- File browsing and code editing powered by Monaco Editor
- Integrated terminal based on xterm.js and node-pty
- In-project search, Git status, diffs, and commit history
- Composable, reusable AI workflows and a template library
- Configuration, session, and plugin management for Codex and Claude Code
- React / Vite web frontend with a Tauri 2 Windows desktop shell
- Local-first: workspaces, AI CLI configuration, and credentials stay on the machine running Osheep

## Architecture

```text
React + Vite
     |
     | HTTP / WebSocket
     v
Fastify + node-pty  ----> File system / Git / AI CLI
     ^
     |
Tauri 2 + WebView2 (Windows desktop)
```

The desktop app launches the Node.js backend as a sidecar, and the backend serves the built frontend assets. The Rust process is only responsible for the desktop window and the lifecycle of the backend child process.

## Requirements

For web development you need:

- Node.js 20 or later (the current LTS is recommended)
- npm
- Git
- The C++ build tools required to compile `node-pty` on Windows
- Optional: Codex CLI or Claude Code CLI, installed and signed in

Building the Windows desktop app additionally requires:

- Rust stable and Cargo
- Visual Studio 2022 Build Tools with the "Desktop development with C++" workload
- Microsoft Edge WebView2 Runtime

## Quick start

Clone the project and install dependencies:

```powershell
git clone https://github.com/psheep303/osheep.git
cd osheep

cd backend
npm ci
cd ..\frontend
npm ci
cd ..
```

Start the frontend and backend from Windows PowerShell:

```powershell
.\dev.ps1
```

The launcher opens two PowerShell windows:

- Frontend: <http://127.0.0.1:5173>
- Backend: <http://127.0.0.1:4178>
- Health check: <http://127.0.0.1:4178/api/health>

You can also start them separately:

```powershell
cd backend
npm run dev
```

```powershell
cd frontend
npm run dev
```

For author mode of the built-in workflow templates, use:

```powershell
.\dev-developer.cmd
```

## Windows desktop app

Check the Tauri environment:

```powershell
cd desktop
npm ci
npx tauri info
```

Start the desktop dev build or build the NSIS installer from the repository root:

```powershell
.\desktop-dev.cmd
.\desktop-build.cmd
```

The installer is written to `desktop/src-tauri/target/release/bundle/nsis/`. See [desktop/README.md](desktop/README.md) for full packaging, logging, and remote-mode instructions.

## Configuration

The backend reads its runtime configuration from environment variables. You can copy [backend/.env.example](backend/.env.example) as a reference, but the app does not load `.env` files automatically; inject variables via your shell, process manager, or deployment platform.

| Variable | Default | Description |
| --- | --- | --- |
| `OSHEEP_HOST` | `127.0.0.1` | Backend listen address |
| `OSHEEP_PORT` | `4178` | Backend listen port |
| `WORKSPACES_ROOT` | `backend/workspaces` | Parent directory for workspaces |
| `MAX_FILE_SIZE_BYTES` | `5242880` | Per-file read/write size limit |
| `MAX_TERMINAL_SESSIONS` | `16` | Maximum concurrent terminals |
| `TERMINAL_IDLE_TIMEOUT_MS` | `0` | Terminal idle timeout, `0` disables it |
| `AGENT_STALL_TIMEOUT_MS` | `1800000` | AI CLI no-output timeout, `0` disables it |
| `CORS_ORIGIN` | `*` | Allowed frontend origins |
| `OSHEEP_TEMPLATES_ROOT` | `~/.osheep/templates` | Runtime template directory |
| `OSHEEP_CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code configuration directory |
| `OSHEEP_CODEX_CONFIG_DIR` | `~/.codex` | Codex configuration directory |

If you need access from other devices, add authentication first, use HTTPS, tighten `CORS_ORIGIN`, and restrict firewall rules. The backend can write files, run Git, and execute terminals — it must never be exposed to the public internet.

## Data and secrets

- Never commit `.env`, `backend/.osheep/`, `.codex/`, `.claude/`, private keys, certificate keys, or cloud credentials.
- Osheep's AI settings may contain plaintext API keys. Use them only on a trusted local machine and keep the permissions of the configuration directories sensible.
- `.gitignore` only prevents new accidental commits; it cannot remove secrets already committed to Git history. If a secret leaks, revoke the key immediately, then clean up the history.
- Before committing, you can run `git status --ignored` and a secret scanner to check what is about to be published.

See [SECURITY.md](SECURITY.md) for how to report security issues privately.

## Project structure

```text
backend/                 Fastify API, PTY, Git, and AI CLI integration
frontend/                React/Vite workbench
desktop/                 Tauri 2 desktop shell and release scripts
backend/template-library Built-in workflow templates
.osheep/docs/            Product and technical design documents
docs/                    Feature notes, design records, and archived reports
```

## Verification

```powershell
cd backend
npm run build
npm test

cd ..\frontend
npm run build
npm run test:workflow-behavior
```

Some UI constraints also have dedicated check scripts; see [frontend/package.json](frontend/package.json).

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before you start, and do not report security vulnerabilities in public issues.

## License

This project is open-sourced under the [MIT License](LICENSE).
