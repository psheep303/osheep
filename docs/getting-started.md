# Getting Started

## 1. Start Osheep

Install Node.js 20+, npm, and Git. Then install the backend and frontend dependencies:

```bash
git clone https://github.com/psheep303/osheep.git
cd osheep
npm --prefix backend ci
npm --prefix frontend ci
```

Run `./dev.sh` on Linux or `.\dev.ps1` on Windows. Open <http://127.0.0.1:5173>.

Linux also needs Python 3 and `build-essential` for `node-pty`. Windows needs the C++ build tools
required by `node-pty`.

## 2. Choose A Workspace

Use the workspace picker to select a project folder or create one. Osheep runs commands and agent
blocks in that workspace, so choose the repository you intend to work on.

## 3. Run A Template

Open **Templates**, choose a template, and open it in the selected workspace. Enter the task in its
Input block and press **Run**. This is the quickest way to learn the canvas.

Templates are safe to adapt: edit the opened workflow without changing the source template. Save a
useful workflow as your own template from the workflow menu.

## 4. Add An Agent When Needed

Install and sign in to a supported agent CLI before running its blocks. Current built-in adapters
are Codex CLI and Claude Code. Their permission controls live in the Agent block inspector.

An agent block is optional. Files, commands, HTTP, Git, JavaScript, and MCP blocks also run locally
in the selected workspace.

## 5. Keep It Local

Osheep listens on `127.0.0.1` by default. Do not expose it to an untrusted network. For a protected
remote single-user setup, use HTTPS plus explicit `CORS_ORIGIN` and `OSHEEP_AUTH_TOKEN`; see the
root README for the security boundary.
