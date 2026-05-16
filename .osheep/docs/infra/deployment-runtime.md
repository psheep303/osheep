# 部署与运行时

## 目标

让 osheep 可以长期跑在一台服务器上，浏览器只是远程访问入口。所有文件、终端、AI 任务都在服务端跑。

---

## 关键定位

- osheep 是 **服务器端 Web IDE**，不是本地工具
- 浏览器**不持有**文件系统访问权——所有 fs / 终端走后端 API
- 工作区文件持久化在服务器上（`WORKSPACES_ROOT` 挂载点）

---

## 当前阶段部署原则

1. 优先单机部署
2. 前后端服务分离但尽量简单
3. 异步任务独立 Worker（后续阶段）
4. 使用 PostgreSQL 和 Redis 作为基础依赖（用于任务编排与状态，文件 / 终端不依赖它们）
5. Docker 先用于执行环境准备，不急于上复杂编排

---

## 推荐部署组件

### Web 前端
- 静态构建产物（Vite `dist/`）
- 由后端或独立的 Nginx 提供
- 通过环境变量 / 注入脚本指定 `VITE_API_BASE` 指向后端

### API 服务（osheep-backend）
- Node.js 20+ + Fastify
- 提供 HTTP API + WebSocket
- 进程内集成 `node-pty` 实现终端
- 单进程足够（IO 密集，CPU 主要被 PTY 进程消耗）

### Worker 服务（后续阶段）
- 消费 BullMQ 任务
- 调用 LLM Provider
- 写回任务结果

### PostgreSQL（后续阶段）
- 存储项目元数据、文档状态、Todo 状态、任务记录

### Redis（后续阶段）
- 作为 BullMQ 队列后端、轻量缓存

---

## 关键挂载点

```
/srv/osheep/workspaces/    →  后端 WORKSPACES_ROOT
/srv/osheep/data/          →  Postgres / Redis 数据卷（后续）
```

部署时建议把 `workspaces/` 放在独立卷上，便于备份与扩容。

---

## 环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| `OSHEEP_HOST` | 监听地址 | `127.0.0.1` |
| `OSHEEP_PORT` | 监听端口 | `4178` |
| `WORKSPACES_ROOT` | 工作区父目录绝对路径 | `./workspaces` |
| `MAX_FILE_SIZE_BYTES` | 单文件读写上限 | `5242880` (5 MB) |
| `MAX_TERMINAL_SESSIONS` | 并发 PTY 上限 | `16` |
| `TERMINAL_IDLE_TIMEOUT_MS` | 终端无活动超时 | `1800000` (30 分钟) |
| `CORS_ORIGIN` | 允许的前端来源 | `*`（生产环境必须改）|

---

## 安全

1. 当前阶段不带认证，**只能跑在内网 / 本机**
2. 后续接入 session / token，配合反向代理做 TLS 终结
3. 终端 / 文件接口都强制路径越界检查，详见 [api-architecture.md](../backend/api-architecture.md)
4. 不要把 `WORKSPACES_ROOT` 指向系统敏感目录（例如 `/`、`C:\`），最佳实践是放在专用子目录

---

## 轻量化原则

1. 不提前引入 Kubernetes
2. 不提前拆过多微服务
3. 不提前做复杂多租户
4. 不提前接入过多模型供应商
5. 优先确保单服务器、单进程、单 workspace 流程稳定
