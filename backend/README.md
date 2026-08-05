# osheep-backend

English | [简体中文](README.zh-CN.md)

Osheep's server provides the file, terminal, Git, workflow, and AI integration APIs. The frontend
uses these APIs to operate on server-side workspace files and PTY sessions; it does **not** access
the browser's local filesystem directly.

## Start

```bash
npm install
npm run dev        # Development: tsx watch
npm run build      # Compile to dist/
npm start          # Production: node dist/index.js
```

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `OSHEEP_HOST` | Listen address | `127.0.0.1` |
| `OSHEEP_PORT` | Listen port | `4178` |
| `WORKSPACES_ROOT` | Workspace parent directory, absolute or relative to cwd | `./workspaces` |
| `MAX_FILE_SIZE_BYTES` | Per-file read/write limit | `5242880` (5 MB) |
| `MAX_TERMINAL_SESSIONS` | Maximum concurrent PTY sessions | `16` |
| `TERMINAL_IDLE_TIMEOUT_MS` | Terminal inactivity timeout; `0` disables it | `0` |
| `AGENT_STALL_TIMEOUT_MS` | Claude/Codex no-output timeout; `0` disables it | `1800000` (30 minutes) |
| `CORS_ORIGIN` | Comma-separated additional trusted frontend origins | Local loopback origins |
| `OSHEEP_AUTH_TOKEN` | Shared token used for initial session exchange on non-loopback hosts | Random local value |

Each first-level directory under `WORKSPACES_ROOT` is a workspace whose directory name is its
`workspaceId`.

## Access Protection

Local mode trusts pages served from `localhost`, `127.0.0.0/8`, and `::1`. The frontend first calls
`POST /api/auth/session` to obtain an `HttpOnly; SameSite=Strict` session cookie. All other APIs and
terminal WebSockets require that cookie, and cross-site browser requests are rejected before a
session can be established.

When `OSHEEP_HOST` is not a loopback address, the backend refuses to start unless it has an
`OSHEEP_AUTH_TOKEN` of at least 32 characters and explicit `CORS_ORIGIN` values. Remote entry
points must use HTTPS. Exchange the token once through `https://host/#osheep-token=TOKEN`. This
shared token is only suitable for controlled single-user deployments and does not replace
multi-user authentication, reverse-proxy access control, or network isolation.

## API Overview

Detailed documentation:

- [.osheep/docs/backend/api-architecture.md](../.osheep/docs/backend/api-architecture.md)
- [.osheep/docs/backend/file-api.md](../.osheep/docs/backend/file-api.md)
- [.osheep/docs/backend/terminal-api.md](../.osheep/docs/backend/terminal-api.md)

### Health and AI CLI Detection

```text
GET /api/health         -> { ok: true }
GET /api/ai/cli-status -> { claude: { installed, path, command }, codex: { ... } }
```

### Workspaces

```text
GET /api/workspaces       List workspaces
GET /api/workspaces/:id   Get workspace metadata and ensure the .osheep layout
```

### Files

```text
GET    /api/workspaces/:id/fs/tree?path=&includeHidden=
GET    /api/workspaces/:id/fs/file?path=
PUT    /api/workspaces/:id/fs/file        body: { path, content, createParents? }
POST   /api/workspaces/:id/fs/entry       body: { path, kind }
POST   /api/workspaces/:id/fs/move        body: { from, to }
POST   /api/workspaces/:id/fs/copy        body: { from, to }
DELETE /api/workspaces/:id/fs/entry?path=&recursive=
GET    /api/workspaces/:id/settings
PUT    /api/workspaces/:id/settings
```

### Terminals

```text
GET    /api/terminals/profiles   List detected server-side shells
GET    /api/terminals            List active sessions
POST   /api/terminals            body: { workspaceId, shell, cols, rows }
DELETE /api/terminals/:id        Kill a PTY
WS     /api/terminals/:id/io     Bidirectional JSON frames
```
