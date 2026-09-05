# Rust 后端重构 P1 实施记录

本阶段在根目录建立 Cargo workspace，并保持 Node 参考服务为当前默认运行时。Rust 服务不代理、
不启动 Node，也不与 Node 同时写入工作区状态。

## Workspace

| crate | 当前职责 |
| --- | --- |
| `osheep-contract` | 健康检查、API 错误、终端 REST DTO 和 WebSocket 帧 |
| `osheep-core` | 无 HTTP 依赖的工作区 ID 校验、根目录解析和边界检查 |
| `osheep-pty` | `PtyRuntime`/`PtySession` trait、ConPTY/Unix PTY、输入/输出队列和回放缓冲 |
| `osheep-server` | axum 路由、Cookie/Origin 认证、终端 REST/WebSocket、静态站点 |
| `desktop/src-tauri` | 现有桌面壳；本阶段只纳入 workspace，尚未切换 sidecar |

## 当前兼容面

- `GET /api/health` 与 `POST /api/auth/session`。
- `GET /api/terminals/profiles`、`GET/POST /api/terminals`、
  `DELETE /api/terminals/:id` 和 `/api/terminals/:id/io`。
- `output`、`replay-start/chunk/end`、`exit`、`error`、`ping/pong` 帧。
- 本地回环 Origin、远程显式 Origin、HttpOnly SameSite Cookie 和 bearer 换取会话。
- 静态资源、SPA fallback、资源 404、ETag、gzip 和 immutable asset 缓存。

PTY 输入队列为 64 条，输出广播为 256 帧；普通终端回放为 256 KiB，持久终端回放为 4 MiB。
慢 WebSocket 消费者发生 lag 时收到错误并断开，避免无界内存；输入通过单一控制任务保持顺序。
Windows 使用 `portable-pty` 的 ConPTY backend，Unix 使用其原生 PTY backend。

P1 骨架已通过实际 Rust 工具链验证：`cargo check --workspace`、
`cargo clippy --workspace --all-targets -- -D warnings` 和 `cargo test --workspace` 均通过。
根目录 `Cargo.lock` 固定当前 workspace 依赖解析结果。

## 尚未完成

- Agent terminal、Agent session、Adapter 和 workflow runner 尚未接入 Rust PTY。
- shell 启动 guard 和进程树终止验证仍属于 P2；工作区 `cd` 输入边界、空闲超时、resize 回放和
  持久会话断线保留已在 P2 第一批实现。
- 桌面端仍启动 Node sidecar；共享服务发现和数据目录迁移属于 P3。
- Node/Rust 双服务黑盒夹具尚未扩展到全部终端错误分支和真实 shell 矩阵。

当前验证命令：

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p osheep-server
```

PowerShell 与 CMD 的真实输入、resize、长输出、退出和清理已在当前 Windows 环境通过；本机未
探测到 Git Bash。完整 P2 状态和剩余矩阵见 [rust-backend-refactor-p2.md](rust-backend-refactor-p2.md)。
在 Git Bash、Linux bash/zsh、Ctrl+C 和进程树测试补齐前，不切换开发代理或桌面 sidecar。
