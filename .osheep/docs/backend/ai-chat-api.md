# AI Chat / Tools API

## 目标

让前端通过后端代理调用 OpenAI 兼容的 LLM 接口，避免把 API Key 暴露给浏览器跨域请求；同时为 **osheep code 的工具调用回路**（读 / 写 / 跑命令）提供受控的服务端执行入口。

当前阶段提供以下接口：

| 路由 | 用途 |
|------|------|
| `POST /api/workspaces/:id/ai/models` | 拉取 Provider 可用模型清单 |
| `POST /api/workspaces/:id/ai/chat`   | 转发一次完整 chat completion（非流式，保留） |
| `POST /api/workspaces/:id/ai/chat/stream` | 转发一次流式 chat completion（SSE，主要路径） |
| `POST /api/workspaces/:id/ai/exec/read`  | 工具：读取文件 / 列目录 / 搜索 |
| `POST /api/workspaces/:id/ai/exec/write` | 工具：写入 / 创建 / 删除 / 重命名 |
| `POST /api/workspaces/:id/ai/exec/run`   | 工具：一次性命令执行（短生命周期 PTY） |

所有 `/ai/exec/*` 入口都是 osheep code 的内部工具调用通道——前端在收到 `tool_call` 流式事件后调它们，再把结果作为下一轮 `messages` 喂回模型。

---

## Provider 协议（kind）

`/ai/models` 与 `/ai/chat[/stream]` 的请求体都新增可选字段 `kind`，默认 `"openai"`：

| kind | 上游协议 | 上游路径 | 鉴权头 |
|------|----------|---------|--------|
| `openai`（默认） | OpenAI Chat Completions | `${baseUrl}/chat/completions` | `Authorization: Bearer <apiKey>` |
| `anthropic` | Anthropic Messages | `${baseUrl}/messages` | `x-api-key: <apiKey>` + `anthropic-version: 2023-06-01`（同时附带 Authorization 以兼容部分代理） |

后端根据 `kind` 自动：

- 转换 messages：Anthropic 不接受 `role: "system"`，会把所有 system 拼接成顶层 `system` 字段；不接受 `role: "tool"`，会折叠成 `role: "user"` 加 `[tool_result <id>]` 前缀；连续同 role 消息合并；首条非 user 时前置一条占位 user
- 翻译 SSE 事件：`event: content_block_delta` → 前端 `event: delta`；`event: message_stop` → 前端 `event: done`；`event: error` → 前端 `event: error`

前端透传 `provider.kind`（来自 `.osheep/settings.json` 中每个 provider 的 `kind` 字段），无需感知上游协议差异。

---

## `POST /api/workspaces/:id/ai/models`

未变化。详见旧版文档/源码。

### 请求体
```json
{ "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "kind": "openai" }
```

- `kind` 缺省 `"openai"`；为 `"anthropic"` 时仍然按 `${baseUrl}/models` 拉取（Anthropic 官方目前没有该端点，但 Claude Code 兼容代理通常实现了它）

### 返回
```json
{ "models": ["gpt-4o-mini", "gpt-4o", "..."] }
```

---

## `POST /api/workspaces/:id/ai/chat`

非流式回退路径。请求体 / 返回体保持向后兼容。

### 请求体

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system",    "content": "..." },
    { "role": "user",      "content": "..." },
    { "role": "assistant", "content": "..." },
    { "role": "tool",      "tool_call_id": "tc_1", "content": "..." }
  ]
}
```

- `role: "tool"` 在上游若不支持，会降级成 `role: "user"`，content 前缀加 `[tool_result tc_1]\n`

### 行为
- 后端拼接 `${baseUrl}/chat/completions`
- 取 `choices[0].message.content` 作为助手回复

### 返回
```json
{ "content": "...", "raw": { /* 上游原始 JSON */ } }
```

---

## `POST /api/workspaces/:id/ai/chat/stream`

**主要路径**。请求体与 `/ai/chat` 完全相同。响应是 SSE。

后端在这里保持透明代理：OpenAI / Anthropic 的上游流被翻译为统一的 `delta` / `done` / `error` 事件。osheep code 的 `<tasks>` / `<thought>` / `<tool>` / `<ask>` / `<verify>` 标记由前端 `TagStreamParser` 从 `delta.content` 中解析；后端不维护 osheep code 标记状态机。

### 标记约定（注入到 system prompt 末尾）

osheep code 在系统提示里告诉模型用下面这套**轻量标记**来组织输出（详见 `ai/osheep-code-prompt.md`）：

```
<tasks>
1. 步骤 1
2. 步骤 2
</tasks>

<thought>让我先读一下这个文件。</thought>

<tool name="read">
{"kind":"file","path":"src/api.ts"}
</tool>

<thought>看到了……</thought>

<ask>
{"question":"接下来我应该重写还是只删除？","options":["重写为更小的函数","只删除冗余分支"]}
</ask>

<verify>所有 console.log 已删除。</verify>
```

> `<tasks>` 是新名字；旧的 `<plan>` 仍被 parser 当作同义别名接受（兼容历史会话与正在迁移中的模型权重），但生成提示词时只输出 `<tasks>`。`<ask>` 由前端在 composer 上方的「审批框位置」渲染为按钮组 + 「其他」（手动输入）入口，详见 `frontend/ai-panel.md`。

不被标记包围的纯文本视为「助手自然语言段落」，由前端从 `delta` 中解析为普通文本 step。

### 事件流

后端只输出统一后的基础 SSE：

```
event: delta
data: {"content":"<tasks>\n- [ ] 读文件\n- [ ] 修改\n</tasks>"}

event: done
data: {}
```

前端 parser 将 `delta.content` 里的标记转换为 timeline step：`plan`（兼容名，UI 显示为 `Tasks`）/ `thought` / `tool_call` / `ask` / `verify` / 普通文本。Tasks 字段格式约定：`items` 数组中的每一项保留**完整的 markdown checkbox 前缀**（`- [ ] 任务` / `- [~] 任务` / `- [x] 任务`），不再剥离 `- ` 与 `[ ]`。

Ask 字段格式约定：`{ question: string, options: string[] }`；前端会自动追加 `「其他」` 手动输入入口，模型在 `options` 里**不应**预留 `其他`。

错误：
```
event: error
data: {"message":"..."}
```

> 兼容性：后端不区分普通模式和 osheep code 模式，始终只发 `delta` / `done` / `error`。是否启用 osheep code 标记解析由前端调用 `aiChatStreamOsheepCode` 决定。

### 请求体新增字段

```json
{
  "baseUrl": "...",
  "apiKey": "...",
  "model": "gpt-4o-mini",
  "messages": [ ... ],
  "reasoning": {
    "effort": "minimal" | "low" | "medium" | "high" | "off"
  }
}
```

- `reasoning.effort` 可选；为已知 reasoning 模型时透传给上游：
  - OpenAI 协议 → 在请求体中加 `reasoning_effort`（值 = `effort`，`off` 等价于不发送，`minimal` 透传为 `minimal`）
  - Anthropic 协议 → 在请求体中加 `thinking: { type: "enabled", budget_tokens: N }`
    - `off` → 不发送 thinking 字段
    - `low` → budget_tokens = 4096
    - `medium` → budget_tokens = 16384
    - `high` → budget_tokens = 32768
  - 其它 provider / 不在白名单的模型 → 字段被丢弃，不影响上游

后端会根据 `model` 名称匹配一份白名单（前缀匹配）决定是否透传：

| Kind | 模型前缀（小写匹配） |
|------|---------------------|
| openai | `gpt-5`、`o1`、`o3`、`o4` |
| anthropic | `claude-3-7-`、`claude-4-`、`claude-opus-4`、`claude-sonnet-4`、`claude-haiku-4` |

落在白名单外的模型即使带 `reasoning.effort` 也被丢弃，保证向后兼容（如 gpt-4o、claude-3-5-sonnet）。

### 响应头

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

前端用 `AbortController` 主动断开时，后端在响应 socket 关闭且上游未结束时关闭上游 fetch。

### 工具调用并不在 SSE 内执行

前端解析出的 `tool_call` 只是**告知 runtime 模型希望调用什么**。具体执行由前端拿到事件后选择性调用 `/ai/exec/*`（参见后续段落），并把结果作为下一轮 messages 重新发起 `/ai/chat/stream`。

这意味着 osheep code 的一次「用户轮次」可能对应多次 SSE：

```
用户发送
  ↓
SSE 1：delta(raw: tasks / thought / tool(read))  → done
  ↓ 前端解析第一条 tool，fetch /ai/exec/read，把 assistant 原文片段 + tool result 追加进 modelTranscript
SSE 2：delta(raw: thought / tool(write))         → done
  ↓ 前端解析第一条 tool，fetch /ai/exec/write，把 assistant 原文片段 + tool result 追加进 modelTranscript
SSE 3：delta(raw: verify / text 或 ask)          → done   ← 没有 accepted tool 视为结束轮
```

前端 runtime 按 Claude Code 式节奏执行：**每个 SSE 响应最多接受第一条 tool**。如果模型同一段里继续输出第二条 `<tool>` 或后续步骤，这些内容不会进入 UI，也不会执行；写回 `modelTranscript` 的 assistant 原文会截断到第一条 accepted tool 结束处，再追加对应 tool result。这样下一轮模型只会基于真实发生过的「思考 → 动作 → 结果」继续，避免把宿主未执行的内容当成事实。

前端循环直到本轮没有 accepted tool 为止，那一次的 `verify` / `ask` / `text` 即最终回复。runtime 必须维护 `modelTranscript`、`TasksState` 与 `<recent-tool-calls-this-turn>` 摘要，避免模型重复 tasks / read / write。

最大工具循环次数硬限制 **40**。此外连续 3 轮没有任何真实工具执行（全部被 tasks gate 拒绝 / 用户拒绝 / 参数无效 / cached）时，runtime 会停止本轮并在 timeline 末尾追加合成 `text` step 说明原因。

---

## 工具执行端点

所有工具端点都受 `workspaceId` 边界约束：路径参数解析在 workspace 根目录之下；越界一律 `403 OUT_OF_WORKSPACE`。

### `POST /api/workspaces/:id/ai/exec/read`

#### 请求体（三种形态之一）
```json
// 读取文件
{ "kind": "file", "path": "src/api.ts" }
// 列出目录
{ "kind": "list", "path": "src/", "includeHidden": false }
// 搜索（前缀匹配现有 search API）
{ "kind": "search", "query": "console.log", "include": "*.ts" }
```

#### 返回
```json
// file
{ "kind": "file", "path": "src/api.ts", "content": "...", "size": 1234, "mtime": 1715..., "truncated": false }
// list
{ "kind": "list", "path": "src/", "entries": [ {"name":"a.ts","kind":"file"} ... ] }
// search
{ "kind": "search", "matches": [ {"path":"...","lines":[...]} ], "truncated": false }
```

AI `read.file` 使用专用读取逻辑：只读取文件开头最多 256KB 并返回 `truncated: true`，不会先被编辑器文件大小上限拦截。模型看到 `truncated=true` 时不得假设未读取部分的内容，应继续用 `read.search` 或更小范围的读写策略。

### `POST /api/workspaces/:id/ai/exec/write`

#### 请求体（操作类型之一）
```json
// 整文件写入 / 创建
{ "kind": "write_file", "path": "src/foo.ts", "content": "...", "createParents": true }
// 整文件追加
{ "kind": "append_file", "path": "src/foo.ts", "content": "..." }
// 文本片段替换（精确匹配 oldString，必须唯一；不唯一返回 400）
{ "kind": "edit_file", "path": "src/foo.ts", "oldString": "...", "newString": "..." }
// 同文件批量替换（按顺序应用，每一步 oldString 在当前文件状态里必须唯一；任意一步失败整批回滚）
{ "kind": "multi_edit", "path": "src/foo.ts", "edits": [
  { "oldString": "...", "newString": "..." },
  { "oldString": "...", "newString": "..." }
] }
// 重命名 / 移动
{ "kind": "move", "from": "src/foo.ts", "to": "src/bar.ts" }
// 删除
{ "kind": "delete", "path": "src/foo.ts", "recursive": false }
```

#### 返回

**通用形态**：

```json
{ "ok": true, "kind": "write_file", "path": "src/foo.ts", "size": 1234, "mtime": 1715... }
```

**edit_file 专属**：除通用字段外，附带 `diff` 结构体，供前端渲染缩略 diff 与「在新标签打开完整 diff」入口。

```json
{
  "ok": true,
  "kind": "edit_file",
  "path": "src/foo.ts",
  "size": 1234,
  "mtime": 1715...,
  "replacements": 1,
  "diff": {
    "oldString": "<原片段>",
    "newString": "<新片段>",
    "startLine": 12,
    "endLineBefore": 15,
    "endLineAfter": 17,
    "added": 5,
    "removed": 3,
    "before": "<整文件原内容>",
    "after": "<整文件新内容>"
  }
}
```

约定：

- `startLine` / `endLineBefore` / `endLineAfter` 全部 **1-based**，方便前端直接定位
- `added` / `removed` 是 `newString` / `oldString` 各自的换行计数（含尾行），用于显示「+N / -M」
- `before` / `after` 是整文件内容；前端用它喂给 Monaco DiffEditor 渲染完整 diff Tab
- chat-runtime 把这份 result 落回给模型前会**剥掉** `diff.before` / `diff.after`（避免再次发回整文件 token），只保留 `oldString` / `newString` / 行号 / 计数

写入路径必须在 workspace 内；否则 `403 OUT_OF_WORKSPACE`。`write_file` 只用于创建新文件或完整内容已知的整文件覆盖；明显占位符内容（例如仅 `...`）会被拒绝，防止误覆盖。局部修改优先使用 `edit_file`，且 `oldString` 必须精确且唯一。

#### `edit_file` 失败诊断

`edit_file` 在 `oldString` 不存在或匹配多处时返回 `400 INVALID_QUERY`，message 中**附带候选行号**让模型自纠错。错误体形态：

```json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "oldString 在 src/foo.ts 中未匹配；可能位置: line 42, 87 (基于 oldString 首行)"
  }
}
```

规则：

- `matchCount=0` 时：如果 `oldString` 的首个非空行能在文件里找到，把命中行号（最多前 5 个）拼到 message 末尾：`...; 可能位置: line A, B, …(基于 oldString 首行)`；找不到则只说「未匹配」
- `matchCount>1` 时：把全部命中行号拼到 message 末尾：`oldString 匹配到 N 处: line A, B, …，请提供更多上下文以唯一定位`

这套 hint 让模型不需要再 `read` 整文件就能 narrow 下一次 `edit_file` 的 `oldString`，减少一轮无谓的工具调用。错误响应仍然是现有的 `{ error: { code, message } }` 二字段格式，前端无需新增类型即可解析。

#### `multi_edit` 专属响应

`multi_edit` 把同文件 N 处修改打包成**一次** tool call。语义：

- 按 `edits` 数组顺序应用，每一步在当前文件状态（即前面 edits 已经生效之后的状态）里 `oldString` 必须恰好出现 1 次
- 任意一步失败 → 整批回滚，**不写盘**，抛 `INVALID_QUERY`，message 形如 `multi_edit edits[2] 失败：oldString 在 src/foo.ts 中未匹配；可能位置: line A, B, …`
- 全部成功 → 一次 `writeFileText`，返回如下结构：

```json
{
  "ok": true,
  "kind": "multi_edit",
  "path": "src/foo.ts",
  "size": 1234,
  "mtime": 1715...,
  "replacements": 3,
  "diff": {
    "edits": [
      {
        "oldString": "<原片段>",
        "newString": "<新片段>",
        "startLine": 12,
        "endLineBefore": 15,
        "endLineAfter": 17,
        "added": 5,
        "removed": 3
      },
      ...
    ],
    "added": 15,
    "removed": 9,
    "before": "<整文件原内容>",
    "after": "<整文件最终内容>"
  }
}
```

约定：

- `replacements = edits.length`（与 `edit_file` 的 1 对应）
- `diff.edits[i]` 的 `startLine` 等行号是相对**当时文件状态**计算的，方便前端在缩略 diff 卡里独立展示每一段
- `diff.added` / `diff.removed` 是所有 edit 行数变化的总和
- `diff.before` / `diff.after` 是整文件的开始 / 结束内容，供 Monaco DiffEditor 渲染「完整 diff →」Tab
- chat-runtime 在把 result 落回给模型前会**剥掉** `diff.before` / `diff.after`，避免 token 浪费

### `POST /api/workspaces/:id/ai/exec/run`

短生命周期命令执行，独立 PTY，cwd 锁在 workspace 根（或 `cwd` 字段指定的子目录）。

#### 请求体
```json
{
  "command": "npm test",
  "cwd": "frontend",
  "shell": "powershell",
  "timeoutMs": 120000,
  "stdin": null
}
```

- `shell` 缺省：在 Windows 用 `powershell`，其余用 `bash`
- `cwd` 相对路径，会与 workspace 根拼接并做越界校验
- `timeoutMs` 默认 60000，硬上限 600000

#### 返回（命令结束后一次性返回）
```json
{
  "command": "npm test",
  "cwd": "frontend",
  "exitCode": 0,
  "signal": null,
  "durationMs": 4321,
  "stdout": "...",
  "stderr": "...",
  "truncated": false
}
```

`stdout` + `stderr` 总长度上限 256KB，超出截断。超时则 `exitCode=null`、`signal="SIGTERM"`、`truncated=true`。HTTP 200 只表示命令完成；`exitCode !== 0` 在 osheep code runtime 中视为工具失败，并把 stdout/stderr 作为下一轮上下文回传给模型。

不支持长驻 / 交互命令——那是终端面板的职责，AI 不应在这里 spawn `npm run dev` 之类的常驻进程。

#### 安全
- workspace 边界守卫与 `/api/terminals` 一致（PowerShell init 脚本注入、cmd helper 等）
- 单 workspace 同时运行的 exec 数量上限 4，超出排队

---

## 错误码

| code | HTTP | 含义 |
|------|------|------|
| `INVALID_QUERY` | 400 | 字段缺失 / 类型错 |
| `OUT_OF_WORKSPACE` | 403 | 路径越界 |
| `WORKSPACE_NOT_FOUND` | 404 | workspaceId 不存在 |
| `UPSTREAM_FAILED` | 502 | 上游 LLM 不可达 / 4xx / 5xx |
| `EXEC_TIMEOUT` | 408 | run 命令超时 |
| `EXEC_FAILED` | 500 | spawn 失败 |

---

## 当前阶段不做

- 多模态输入
- Token / 费用统计
- 服务端缓存
- Provider 配置在服务端校验（仍由前端从 settings.json 取出再原样转发）
- 文本片段替换的 fuzzy 匹配（必须精确 + 唯一）
- run 接口的长驻 / 交互命令
- 跨刷新恢复对话流（runtime 模块运行在前端单例里）
