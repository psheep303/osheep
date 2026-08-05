# Osheep

[![CI](https://github.com/psheep303/osheep/actions/workflows/ci.yml/badge.svg)](https://github.com/psheep303/osheep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Osheep is a local development workbench built around AI workflows. It brings code editing, terminals, search, Git, workflow templates, and Codex / Claude Code integration into a single interface. The web app runs on Linux and Windows, while the desktop app currently targets Windows.

> The project is still in early development; APIs, configuration formats, and interactions may change in incompatible ways. Single-machine, single-user scenarios are the current priority — do not expose the backend directly to untrusted networks.

## Features

- File browsing and code editing powered by Monaco Editor
- Integrated terminal based on xterm.js and node-pty
- In-project search, Git status, diffs, and commit history
- Composable, reusable AI workflows and a template library
- Configuration, session, and plugin management for Codex and Claude Code
- Linux/Windows web development with a Tauri 2 Windows desktop shell
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
- `build-essential` and Python 3 to compile `node-pty` on Linux
- The C++ build tools required to compile `node-pty` on Windows
- Optional: Codex CLI or Claude Code CLI, installed and signed in

Building the Windows desktop app additionally requires:

- Rust stable and Cargo
- Visual Studio 2022 Build Tools with the "Desktop development with C++" workload
- Microsoft Edge WebView2 Runtime

## Quick start

On Ubuntu 22.04/24.04, install the system dependencies first:

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 git
```

After installing Node.js 20+, clone the project and install dependencies:

```bash
git clone https://github.com/psheep303/osheep.git
cd osheep
npm --prefix backend ci
npm --prefix frontend ci
```

Start both web development processes from the repository root on Linux:

```bash
bash ./dev.sh
```

The script manages both processes in one terminal. Use `--backend-only`, `--frontend-only`, `--developer`, or `--install` as needed; `Ctrl+C` stops both processes.

On Windows, install and start with PowerShell:

```powershell
git clone https://github.com/psheep303/osheep.git
cd osheep

cd backend
npm ci
cd ..\frontend
npm ci
cd ..
```

```powershell
.\dev.ps1
```

After startup, open:

- Frontend: <http://127.0.0.1:5173>
- Backend: <http://127.0.0.1:4178>
- Health check: <http://127.0.0.1:4178/api/health>

On either platform, you can also start them separately:

```bash
cd backend
npm run dev
```

```bash
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
| `CORS_ORIGIN` | Loopback origins | Comma-separated additional trusted frontend origins |
| `OSHEEP_AUTH_TOKEN` | Random local value | Shared access token required for non-loopback listening |
| `OSHEEP_TEMPLATES_ROOT` | `~/.osheep/templates` | Runtime template directory |
| `OSHEEP_CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code configuration directory |
| `OSHEEP_CODEX_CONFIG_DIR` | `~/.codex` | Codex configuration directory |

Local mode automatically establishes an Origin-restricted `HttpOnly` session; APIs and terminal WebSockets reject unauthorized pages. Non-loopback listening requires both a random `OSHEEP_AUTH_TOKEN` of at least 32 characters and explicit `CORS_ORIGIN` values, and must use HTTPS. Open `https://host/#osheep-token=TOKEN` once to exchange the token for a session; the token is then removed from the address bar. This shared token is intended for controlled single-user deployments and does not replace multi-user authentication, reverse-proxy access control, or firewall rules.

## Data and secrets

- Never commit `.env`, `backend/.osheep/`, `.codex/`, `.claude/`, private keys, certificate keys, or cloud credentials.
- Osheep's AI settings may contain plaintext API keys. Use them only on a trusted local machine and keep the permissions of the configuration directories sensible.
- `.gitignore` only prevents new accidental commits; it cannot remove secrets already committed to Git history. If a secret leaks, revoke the key immediately, then clean up the history.
- Before committing, run `node scripts/check-public-repo.mjs`; before making the repository public, also scan the complete Git history with Gitleaks.

See [SECURITY.md](SECURITY.md) for how to report security issues privately.

## Project structure

```text
backend/                 Fastify API, PTY, Git, and AI CLI integration
frontend/                React/Vite workbench
desktop/                 Tauri 2 desktop shell and release scripts
backend/template-library Built-in workflow templates
.osheep/docs/            Product and technical design documents
docs/                    User-facing and maintainer-facing feature notes
```

## Verification

On Linux, run the same clean installation, Bash/Git/node-pty/AI CLI detection, test, and build flow used by CI:

```bash
bash scripts/verify-linux.sh
```

Platform-neutral local verification commands are:

```bash
npm --prefix backend run lint
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
```

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before you start, and do not report security vulnerabilities in public issues.

## License

This project is open-sourced under the [MIT License](LICENSE).
