# Rust 后端重构 P2 实施记录

P2 按“先完成普通终端核心，再接入 Agent/Adapter/workflow”的顺序推进。Node 仍是默认后端，
当前 Rust 服务不代理或启动 Node，`node-pty` 尚未删除。

## 本批已实现

- 普通终端使用 256 KiB 回放，持久终端使用 4 MiB 回放；按 UTF-8 边界截断，并使用与
  JavaScript 一致的 UTF-16 offset 记录 resize。
- 截断回放从安全 ANSI 锚点恢复，重算初始尺寸和 resize offset；无输出间的连续 resize 合并。
- 回放快照和输出订阅采用原子 attach，消除 attach 期间丢帧或重复帧的竞态。
- WebSocket 仅在普通终端断线时终止 PTY；持久终端保留进程、输出和 resize 回放。
- PTY 自然退出、显式 kill、输入失败和空闲超时统一进入清理路径；最终 `exit/error` 帧等待输出
  读取任务排空，避免尾部输出晚于退出帧。
- PTY 退出后立即从 runtime 会话表移除；`TERMINAL_IDLE_TIMEOUT_MS` 与 Node 配置语义对齐。
- `cd`、`chdir`、`Set-Location`、`pushd` 的可信输入行执行工作区根边界检查；Alt+Enter 保持单次
  PTY 写入。工作区根在传给 PTY 前 canonicalize。
- Windows shell cwd 移除 canonicalize 产生的 verbatim path 前缀，避免 CMD 将本地路径误判为
  不支持的 UNC cwd。
- HTTP 黑盒契约覆盖认证、profiles、终端创建、列表、删除、错误分支和静态站点。
- `live_terminal` 集成测试监听随机回环端口，使用真实 session cookie、REST 创建、WebSocket
  replay/input/output/exit 和 native PTY，并验证退出后 REST 会话表完成清理。

## 已验证

```powershell
cargo fmt --all -- --check
cargo check --workspace --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
cargo test --workspace --offline
```

全 workspace Rust 测试通过。Windows 实机 PTY 测试逐一运行本机探测到的 PowerShell 和 CMD，
覆盖输入、UTF-8（PowerShell）、ANSI（PowerShell）、resize、长输出、正常退出、会话清理以及
持久会话断线回放；真实 HTTP/WebSocket 路径也通过 PowerShell 往返测试。本机未探测到 Git Bash。

Node PTY 回放基准测试及前端 terminal conversation/keyboard 测试继续通过。

## P2 剩余工作

- 把 PowerShell、CMD、bash/zsh 的 shell 启动 guard 迁移到 Rust；当前输入行检查只是防御层，
  遇到补全、方向键或复杂 shell 语法时会保守放弃解析，不能替代 shell 内 guard。
- 将 Agent terminal、Agent session、Adapter 和 workflow runner 直接接入 Rust PTY；完成前不删除
  `node-pty` 或 `backend/src/pty.ts`。
- 补齐 Windows Git Bash、Linux bash/zsh、Ctrl+C、连续 resize、Alt+Enter、进程树终止和真实
  WebSocket 慢消费者/重连测试；当前 live test 已覆盖单客户端连接、输入、输出和正常退出。
- 验证多客户端 attach 策略和持久终端的空闲策略，再固定 Agent/工作流使用的公开创建接口。
- 桌面端仍启动 Node sidecar；共享 Rust 服务发现与生命周期属于 P3，不在本批切换。
