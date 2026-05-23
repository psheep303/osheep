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

osheep code 的协议**不**让模型自己输出结构化 JSON——后端在转发上游 token 时，根据**特殊标记**把原始字符流切成不同语义事件转发给前端。

### 标记约定（注入到 system prompt 末尾）

osheep code 在系统提示里告诉模型用下面这套**轻量标记**来组织输出（详见 `ai/osheep-code-prompt.md`）：

```
<plan>
1. 步骤 1
2. 步骤 2
</plan>

<thought>让我先读一下这个文件。</thought>

<tool name="read">
{"path":"src/api.ts"}
</tool>

<thought>看到了……</thought>

<verify>所有 console.log 已删除。</verify>
```

不被标记包围的纯文本视为「助手自然语言段落」，作为 `text_delta` 转发，也会一并落到 `assistant.content`。

### 事件流

后端边读上游 token 边维护一个标记状态机，按下列方式转 SSE：

```
event: plan
data: {"items":["- [ ] 读文件","- [ ] 替换","- [ ] 验证"]}

event: thought
data: {"id":"t1","text":""}

event: thought_delta
data: {"id":"t1","content":"让我先"}

event: thought_delta
data: {"id":"t1","content":"读一下这个文件。"}

event: tool_call
data: {"id":"tc_1","tool":"read","args":{"path":"src/api.ts"}}

event: text_delta
data: {"content":"已经修改完成。"}

event: verify
data: {"text":"所有 console.log 已删除。"}

event: done
data: {}
```

> Plan 字段格式约定：`items` 数组中的每一项保留**完整的 markdown checkbox 前缀**（`- [ ] 任务` / `- [~] 任务` / `- [x] 任务`），不再剥离 `- ` 与 `[ ]`。前端将它们用 `\n` 连接后直接交给 marked 渲染，由 GFM task-list 解析。如果上游模型出现不带 `- ` 前缀的纯文本行（兼容旧实现），前端会在渲染前把它当作未做项补齐成 `- [ ] 文本`。

错误：
```
event: error
data: {"message":"..."}
```

> 兼容性：标记解析仅在 system prompt 注入的「osheep code 模式」时生效。前端通过 `mode=osheepcode` 请求体字段开启。普通模式下，后端仍然像现在一样只发 `delta` 事件，前端按纯文本流式渲染。

### 请求体新增字段

```json
{
  "baseUrl": "...",
  "apiKey": "...",
  "model": "gpt-4o-mini",
  "mode": "osheepcode",          // 可选；为 "osheepcode" 时启用标记解析
  "messages": [ ... ],
  "reasoning": {
    "effort": "minimal" | "low" | "medium" | "high" | "off"
  }
}
```

- `mode` 缺省 / 任意其它值 → 走原始透传逻辑（仅 `delta` / `done` / `error`）
- `mode: "osheepcode"` → 启用标记切分
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

前端用 `AbortController` 主动断开时，后端检测到 `req.raw.aborted` 立即关闭上游 fetch。

### 工具调用并不在 SSE 内执行

`tool_call` 只是**告知前端模型希望调用什么**。具体执行由前端拿到事件后选择性调用 `/ai/exec/*`（参见后续段落），并把结果作为下一轮 messages 重新发起 `/ai/chat/stream`。

这意味着 osheep code 的一次「用户轮次」可能对应多次 SSE：

```
用户发送
  ↓
SSE 1：plan / thought / tool_call(read)  → done
  ↓ 前端 fetch /ai/exec/read，拼回 messages
SSE 2：thought / tool_call(write)        → done
  ↓ 前端 fetch /ai/exec/write，拼回 messages
SSE 3：thought / verify / text           → done   ← 没有 tool_call 视为结束轮
```

前端循环直到收到的 SSE 中**没有任何 tool_call** 为止，那一次的 `verify` / `text` 即最终回复。

最大循环次数硬限制 **8**，避免模型陷入死循环。超过后注入一条 `system` 提醒并强制停止。

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
{ "kind": "file", "path": "src/api.ts", "content": "...", "size": 1234, "mtime": 1715... }
// list
{ "kind": "list", "path": "src/", "entries": [ {"name":"a.ts","kind":"file"} ... ] }
// search
{ "kind": "search", "matches": [ {"path":"...","lines":[...]} ], "truncated": false }
```

`read` 接口对单文件 size 上限 256KB，超出截断并附 `truncated: true`。

### `POST /api/workspaces/:id/ai/exec/write`

#### 请求体（操作类型之一）
```json
// 整文件写入 / 创建
{ "kind": "write_file", "path": "src/foo.ts", "content": "...", "createParents": true }
// 整文件追加
{ "kind": "append_file", "path": "src/foo.ts", "content": "..." }
// 文本片段替换（精确匹配 oldString，必须唯一；不唯一返回 400）
{ "kind": "edit_file", "path": "src/foo.ts", "oldString": "...", "newString": "..." }
// 重命名 / 移动
{ "kind": "move", "from": "src/foo.ts", "to": "src/bar.ts" }
// 删除
{ "kind": "delete", "path": "src/foo.ts", "recursive": false }
```

#### 返回
```json
{ "ok": true, "path": "src/foo.ts", "size": 1234, "mtime": 1715..., "diffSummary": "+12 / -3" }
```

写入路径必须在 workspace 内；否则 `403 OUT_OF_WORKSPACE`。

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

`stdout` + `stderr` 总长度上限 256KB，超出截断。超时则 `exitCode=null`、`signal="SIGTERM"`、`truncated=true`。

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
