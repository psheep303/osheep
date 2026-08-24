# osheep-backend

简体中文 · [English](README.en.md)

osheep 的服务器端：文件 API + 终端 API。前端通过这套接口操作服务器上的工作区文件、运行 PTY，**不**走浏览器本地磁盘。

## 启动

```bash
npm install
npm run dev        # 开发：tsx watch
npm run build      # 编译到 dist/
npm start          # 生产：node dist/index.js
```

## 环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| `OSHEEP_HOST` | 监听地址 | `127.0.0.1` |
| `OSHEEP_PORT` | 监听端口 | `4178` |
| `WORKSPACES_ROOT` | 工作区父目录（绝对路径或相对 cwd） | `./workspaces` |
| `MAX_FILE_SIZE_BYTES` | 单文件读写上限 | `5242880` (5 MB) |
| `MAX_TERMINAL_SESSIONS` | 并发 PTY 上限 | `16` |
| `TERMINAL_IDLE_TIMEOUT_MS` | 终端无活动超时；`0` 表示禁用 | `0` (禁用) |
| `AGENT_STALL_TIMEOUT_MS` | Claude/Codex 连续无终端输出时判定卡住；不限制总运行时长，`0` 表示禁用 | `1800000` (30 分钟) |
| `CORS_ORIGIN` | 逗号分隔的额外可信前端来源 | 本地回环来源 |
| `OSHEEP_AUTH_TOKEN` | 非本地监听时用于首次会话交换的共享令牌 | 本地随机生成 |

`WORKSPACES_ROOT` 下每个一级子目录就是一个 workspace，目录名为 `workspaceId`。

## 访问保护

本地模式只信任 `localhost`、`127.0.0.0/8` 和 `::1` 页面。前端首次访问
`POST /api/auth/session` 后取得 `HttpOnly; SameSite=Strict` 会话 Cookie，其他 API 和终端
WebSocket 均要求该 Cookie；跨站浏览器请求会在建立会话前被拒绝。

当 `OSHEEP_HOST` 不是回环地址时，后端会拒绝在缺少至少 32 字符的 `OSHEEP_AUTH_TOKEN` 或显式
`CORS_ORIGIN` 的情况下启动。远程入口应使用 HTTPS，并通过
`https://host/#osheep-token=TOKEN` 首次交换令牌。该共享令牌只适合受控的单用户部署，
不能替代多用户身份认证、反向代理访问控制或网络隔离。

## API 概览

详见：

- [.osheep/docs/backend/api-architecture.md](../.osheep/docs/backend/api-architecture.md)
- [.osheep/docs/backend/file-api.md](../.osheep/docs/backend/file-api.md)
- [.osheep/docs/backend/terminal-api.md](../.osheep/docs/backend/terminal-api.md)

### 健康检查

```
GET /api/health → { ok: true }
```

AI CLI 可用性检测：

```text
GET /api/ai/cli-status → { claude: { installed, path, command }, codex: { ... } }
```

### 工作区

```
GET    /api/workspaces                列出 workspaces
GET    /api/workspaces/:id            workspace 元信息（自动 ensure .osheep）
```

### 文件

```
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

### 终端

```
GET    /api/terminals/profiles            服务器探测到的 shell 列表
GET    /api/terminals                     当前活跃会话列表
POST   /api/terminals                     body: { workspaceId, shell, cols, rows }
DELETE /api/terminals/:id                 kill PTY
WS     /api/terminals/:id/io              双向 JSON 帧
```
