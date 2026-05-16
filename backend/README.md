# osheep-backend

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
| `TERMINAL_IDLE_TIMEOUT_MS` | 终端无活动超时 | `1800000` (30 分钟) |
| `CORS_ORIGIN` | 允许的前端来源 | `*` |

`WORKSPACES_ROOT` 下每个一级子目录就是一个 workspace，目录名为 `workspaceId`。

## API 概览

详见：

- [.osheep/docs/backend/api-architecture.md](../.osheep/docs/backend/api-architecture.md)
- [.osheep/docs/backend/file-api.md](../.osheep/docs/backend/file-api.md)
- [.osheep/docs/backend/terminal-api.md](../.osheep/docs/backend/terminal-api.md)

### 健康检查

```
GET /api/health → { ok: true }
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
