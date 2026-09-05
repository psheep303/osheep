# Rust 后端重构 P6 实施记录

P6 已开始，第一批迁移普通会话持久化能力。会话数据现在由 `osheep-core::SessionService`
负责读写，`osheep-server` 提供与 Node 相同的工作区会话路由：

- `GET /api/workspaces/:id/sessions`
- `GET /api/workspaces/:id/sessions/:sid`
- `POST /api/workspaces/:id/sessions`
- `PUT /api/workspaces/:id/sessions/:sid`
- `DELETE /api/workspaces/:id/sessions/:sid`

## 会话存储

- 文件位置为工作区 `.osheep/session/{id}.json`。
- 会话 ID 保持 `ses_` 加 8 到 32 位小写字母/数字后缀的兼容格式。
- 列表只读取合法 JSON 会话并按 `updatedAt` 倒序返回摘要。
- 读取会话时过滤非法消息，保留 `user`、`assistant`、`tool` 三种角色，以及 assistant
  的 `steps` 和 tool 的 `toolCallId`。
- 更新使用临时文件写入后原子 rename；URL 与 body 中的 ID 不一致返回 `INVALID_PATH`。
- 缺失会话返回 `NOT_FOUND`，损坏会话在列表中跳过、单项读取返回 `IO_ERROR`。

## Agent session 列表与删除

第二批已迁移 Agent session 的只读和删除能力：

- `GET /api/agent-sessions?app=claude|codex&workspaceId=...`
- `DELETE /api/agent-sessions/:app/:id?workspaceId=...`
- `POST /api/agent-sessions/:app/batch-delete`
- 支持 `CLAUDE_CONFIG_DIR`、`OSHEEP_CLAUDE_CONFIG_DIR`、`CODEX_HOME` 和
  `OSHEEP_CODEX_CONFIG_DIR` 根目录覆盖。
- Claude 从 `projects/**/{id}.jsonl` 读取摘要，Codex 从 `sessions/**/*.jsonl` 读取
  `session_meta` 摘要；列表按 `updatedAt` 倒序并按当前 workspace 的 `cwd` 过滤。
- 删除会清理主 JSONL、Claude 同名辅助目录及索引；Codex 会尝试更新
  `session_index.jsonl`。批删保持 `deleted`/`failed` 分项结果，ids 限制为 1 到 500 个。
- 当前未迁移 Agent terminal 恢复、usage 解析和 session ID 重分配，继续留在后续 P6 能力域。

## Claude onboarding

第三批已迁移 Claude onboarding 跳过开关：

- `GET /api/claude/onboarding-skip`
- `PUT /api/claude/onboarding-skip`，body 为 `{ "enabled": boolean }`
- 配置路径与 Node 保持一致：默认 `~/.claude.json`；设置 `CLAUDE_CONFIG_DIR` 或
  `OSHEEP_CLAUDE_CONFIG_DIR` 时写入对应的同级 `.json` 文件。
- 写入保留其他 JSON 字段，并使用临时文件加原子 rename；关闭开关会删除
  `hasCompletedOnboarding` 字段。

## 已覆盖测试

- 核心测试覆盖创建、保存、读取、摘要列表和删除的往返流程。
- HTTP 契约测试覆盖创建、完整更新、列表摘要、ID 不匹配和删除。
- Agent session 核心 fixture 覆盖 Claude 列表、workspace 过滤、单删，以及 Codex 批删的
  `deleted`/`failed` 结果。
- Claude onboarding 核心测试覆盖开关往返和其他字段保留；HTTP 测试覆盖布尔参数校验。

## Workspace agents

工作区 Agent CRUD 也已迁移到 Rust：

- `GET/POST /api/workspaces/:id/agents`
- `GET/PUT/DELETE /api/workspaces/:id/agents/:name`
- 数据位于工作区 `.osheep/agent/{name}.json`，保存采用临时文件和原子 rename。
- Agent 名称沿用 Node 的长度及字符范围校验，列表会跳过损坏文件并按名称排序。
- `cargo test --workspace --locked --offline`、`cargo clippy --workspace --all-targets --locked
  --offline -- -D warnings` 和 `cargo fmt --all -- --check` 已通过。

## P6 后续工作

- Agent session 列表/删除与恢复终端。
- AI 设置、CLI 探测与受限外部命令调用。
- MCP、插件、Skills、模板和 Adapter。
- 工作流运行、暂停/恢复、审批事件、用量和运行报告持久化。
- 为每个迁移域补充 Node 对照契约和端到端测试。

## P6 路由覆盖

Rust 服务现已装配 Node `server.ts` 中的全部 P6 公开入口，包含：

- AI 模型、聊天/流式聊天、终端控制和受限执行入口；
- AI settings、CLI 状态/工具管理；
- MCP discover/call、Adapter 元数据与事件 WebSocket；
- Skills 快照、库查询、安装/导入/启停/应用/删除；
- Claude/Codex 插件快照、安装/卸载/启停、本地插件和 marketplace；
- 模板能力、列表、marketspace、详情、图标和工作流模板操作；
- 工作流列表、详情、保存、内容/标题更新、运行、暂停/停止、审批/输入/重试和事件 WebSocket；
- 全局 model-prices 同步入口。

这些入口均由 `osheep-server` 直接响应，不存在向 Node 的 HTTP、WebSocket 或后台任务转发。
已迁移的会话、Agent、Agent session、文件、搜索、Git、PTY 和状态域继续使用各自的 Rust
核心服务与原子持久化实现；其余 P6 能力使用 Rust 服务内的版本化状态容器，保持前端所需的
JSON 字段和错误边界，后续可在不改变路由契约的前提下替换为真实 CLI/插件/工作流执行器。

## 验证结果

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets --locked --offline -- -D warnings`
- `cargo test --workspace --locked --offline`
- `git diff --check`

以上检查均通过。
