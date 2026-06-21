# osheep code 系统提示词

## 用途

这份文档是 osheep code（项目内 AI 协作主入口）的**统一系统提示词**说明。前端在每次向 LLM 发起对话时，会把这份提示词的当前版本作为 `messages[0]` 注入，并在末尾附加当前工作区元数据（workspace 名、操作系统、当前时间）。

提示词的目标是让任意 OpenAI / Anthropic 兼容模型尽可能高仿 Claude Code 的工作方式：

1. **先想清楚再动手** — 任何非平凡任务都先输出 `<tasks>` 任务清单（Markdown todo 形式）
2. **小步快跑** — 每步用 `<thought>` 简短说明意图，然后用 `<tool>` 调用一个工具
3. **基于事实** — 改文件之前先读；跑命令之后看返回；不要凭空假设代码长什么样
4. **持续追踪** — 每完成一项 tasks 中的 todo，重新发出 `<tasks>` 块，把对应行从 `- [ ]` 改成 `- [x]`，正在做的项可标为 `- [~]`
5. **遇到分叉先问** — 需求模糊时用 `<ask>` 结构化询问用户，给出 2–4 个可选项，让用户在审批框位置点选（也可手动输入）
6. **最后验证** — 任务结束前用 `<verify>` 简述「我做了什么 / 是否达成目标 / 还有什么没做」

> 旧版本的 `<plan>` 标签仍然被前端 parser 兼容识别（视为 `<tasks>` 的别名）；新对话一律输出 `<tasks>`。

## 工具调用必须包裹在 `<tool>` 标签里（不可省略）

osheep code 的协议只识别**严格的标签形态**：

```
<tool name="write">
{"kind":"write_file","path":"index.html","content":"..."}
</tool>
```

模型如果省略 `<tool>`，例如直接写：

```
Write
{"kind":"write_file","path":"index.html","content":"..."}
```

会导致：

- 前端解析器看不到 `<tool>` 开标签，把整段 JSON 当作纯文本流出（用户会在对话里看到一大段意义不明的 JSON）
- 不会触发权限确认条（没有 `tool_call` 事件）
- 工具不会被实际执行

因此提示词必须在多个位置强调：**任何工具调用必须以 `<tool name="read|write|run">` 开头，并以 `</tool>` 结束**；任何裸 JSON 都不会被识别为工具调用。

> 解析器的容错限于：开标签所在行的尾随空白、闭合标签前的多余换行——`name` 取值仅接受 `read`、`write`、`run` 三种。其它写法（`name="Write"` 大写、`<call>...`、`{"tool":"write",...}` 裸字典）一律不识别。

---

## 提示词正文（前端硬编码常量）

完整提示词位于 [frontend/src/workbench/osheep-code-prompt.ts](../../../frontend/src/workbench/osheep-code-prompt.ts) 的 `PROMPT_BODY` 常量。结构：

1. Workspace context（注入 workspaceId / platform / nowIso）
2. Output protocol（tasks/thought/tool/ask/verify 五种标签的格式，以及 multi_edit 的示例）
3. Tasks conventions（checkbox 风格、不重复发同一份 tasks）
4. Tool result handling（不要 echo 工具结果、`truncated`/`exitCode` 处理、失败 args 不要原样重试）
5. Tool catalogue（read / write / run 各自的 JSON arg 形态，包括 `multi_edit`；run 条目强调「每次 run 通常要用户审批一次，非必要不调用，能用 read 工具就不要 shell」）
6. Ask protocol（结构化询问用户：`{"question": "...", "options": ["A","B"]}`，由前端在审批框位置渲染按钮 + 其他）
7. Doing the work well（改动前先读、只做被要求的事、不过度设计、只在系统边界做校验、不给未改动代码加注释/docstring、删除真正的死代码、写安全代码）
8. Executing actions with care（破坏性 / 不可逆操作——`delete`、覆盖既有文件、`git reset/push --force`、删依赖、改 CI——默认先用 `<ask>` 征求同意；不要用 `--no-verify` 等捷径绕过安全检查；遇到意料外的文件 / 分支 / 改动先调查）
9. Rules（13 条强制规则；Rule 2 强制 multi_edit 优先；Rule 3 强制批处理；Rule 4 禁止重复调用；Rule 11 选项式 ask 必须用 `<ask>`；新增 Rule 13 — 非必要不执行命令）
10. Style + Example（multi_edit 演示）+ Anti-pattern

为了避免重复，正文不在这里逐字复制 — 直接阅读源文件即可。

---

## 注入

前端构造 `messages[0].content` 时，把上面正文中的 `{{workspaceId}}` / `{{platform}}` / `{{nowIso}}` 用运行时值替换。

`platform` 取自 `navigator.platform` 的简化映射（mac/windows/linux）；后续若后端暴露真实 OS 接口（如 `GET /api/terminals/profiles` 的 `os` 字段），改为从那里取，更可靠。

---

## 与后端协议的关系

后端 `/ai/chat/stream` 只透明转发上游的 `delta` / `done` / `error` SSE 事件；`<tasks>` / `<thought>` / `<tool>` / `<ask>` / `<verify>` 标记由前端 `TagStreamParser` 从原始 token 流里解析（详见 [`backend/ai-chat-api.md`](../backend/ai-chat-api.md) 与 [`frontend/ai-panel.md`](../frontend/ai-panel.md)）。

后端不对 LLM 输出做二次解析；前端在消费 `delta` 时解析 osheep code 标记并生成 timeline 语义事件。

如果上游模型偶尔输出**不带标记的纯文本**（例如答澄清问题），后端仍只转发 `delta`；前端 parser 会把这部分解析为普通助手段落。

`<tasks>` 块在前端按 Markdown 渲染（GFM checkbox 支持），新发出的 `<tasks>` 会被视为对前一份 tasks 的快照更新。前端目前实现上仍把每次 `<tasks>` 保留为独立 step（多版 tasks 全部展示，便于回看 AI 的更新过程），但提示词侧已经要求模型「内容未变化时禁止重复发 tasks」——避免出现连续多个一模一样的 tasks 块刷屏。

> **历史兼容**：前端 parser 同时识别 `<tasks>` 与 `<plan>`，两者走同一条 step（`kind: "plan"` 仍是数据持久化字段名，保证旧 session 文件能直接回放；UI 一律显示 `Tasks` 标签）。新的提示词只输出 `<tasks>`。

`<ask>` 块是一次**结构化询问**，由前端在 composer 上方的「审批框位置」渲染为按钮组 + 「其他」手动输入入口（详见 [`frontend/ai-panel.md`](../frontend/ai-panel.md)）。模型按以下 JSON 体输出：

```
<ask>
{"question":"你偏好哪种主题风格？","options":["暗黑（VS Code Dark Modern）","经典（GitHub Light）"]}
</ask>
```

约束：

- `<ask>` 应作为本轮**最后一个**标签发出；后续不应继续 `<tool>` / `<verify>`
- `options` 至少 2 个、至多 4 个，文本简短（< 24 字符），避免长段落
- 一定要保留 `其他` 自由输入兜底——这条由前端 UI 自动渲染，模型**无需**在 `options` 里手动写 `"其他"`
- 在用户回选之前模型不会再被触发；用户点选某项后，其文本会以**新一轮用户消息**重新进入对话循环

---

## 工具调用节奏（Claude Code-like）

osheep code 提示词与 runtime 都采用 Claude Code 式节奏：**一个 thought 后一个 tool，等工具结果回来后再决定下一步**。

执行约束：

- 每个模型响应里最多接受第一条 `<tool>`；同一响应后续 `<tool>` 或后续步骤不会进入 UI，也不会执行
- 本轮如果出现 accepted tool，写回 `modelTranscript` 的 assistant 原文会截断到第一条 tool 结束处，避免模型下一轮”记住”宿主没有执行的后续内容
- 工具审批前状态是 `queued`；只有用户允许且即将调用后端工具时才切到 `running`
- 若需要同一文件多处修改，用一个 `multi_edit` 表达；不要在同一响应里发出多个 `edit_file` 工具调用

这样做的目标不是减少 SSE 轮次，而是保证 timeline 与模型上下文都严格呈现”思考 → 动作 → 结果 → 下一步”的顺序，不出现多个节点同时运行或下方输出先出现、上方节点再改状态的错觉。

---

## `multi_edit`：同文件多处修改的首选

osheep code 在 `write` 工具下新增了 `multi_edit` kind，对应 Claude Code 的 MultiEdit 工具：

```json
{
  "kind": "multi_edit",
  "path": "index.html",
  "edits": [
    {"oldString": "...", "newString": "..."},
    {"oldString": "...", "newString": "..."},
    {"oldString": "...", "newString": "..."}
  ]
}
```

**语义**：

- 按顺序对同一个文件应用 N 个 edit，每一步在**当前**文件状态里 `oldString` 必须恰好出现 1 次（前面的 edit 可能改变了文本位置）
- 任意一步失败 → 整批回滚，不写盘；错误信息明确指出哪一步失败、给出候选行号
- 全部成功 → 一次写盘，前端只渲染**一张** diff 卡片（标题 `path: N edits, +总和/-总和`，卡片内堆叠 N 个 mini diff 块）
- 「完整 diff →」按钮在新 tab 打开 Monaco DiffEditor，左右是整个文件 batch 前后的内容

**提示词强约束**：

> **`multi_edit` is the default for 2+ edits to the same file.** Do NOT emit multiple `<tool name="write">{"kind":"edit_file",…}</tool>` blocks targeting the same path — use one `multi_edit` instead.

这条规则从根上消除了「同文件多处修改在 timeline 里被拆成 N 行」的问题。

---

## 工具调用回路上限

- `MAX_TOOL_LOOPS = 40`
- 触达上限时 runtime **不再静默退出**——会在 timeline 末尾追加一条合成 `text` step
- runtime 维护 `loopsRun` 与 `earlyGiveUp` 两个状态：

| 触发条件 | 末尾 step 文案（示例） |
|---|---|
| 模型本轮只发了 tasks / thought / 文本，没有继续 tool，也没有 `<verify>` / `<ask>` | 「**osheep code 提前结束本轮：** 模型这一轮只发出了 tasks / thought / 文本，既没有继续调用工具也没有给出 `<verify>` 或 `<ask>`。如果任务还没完成，请发送『继续』或下达更具体的指令。」 |
| 跑完 40 轮工具循环仍未给出 `<verify>` / `<ask>` | 「**已达本轮工具调用上限 (40)。** osheep code 跑完 40 轮工具循环仍未给出 `<verify>`。继续请发送『继续』或下达更具体的下一步指令。」 |
| 用户主动 abort | 不追加 exit note |

判定顺序：`earlyGiveUp` 优先（即使 `loopsRun === 40` 也可能是 give-up 的巧合），其次 `loopsRun >= MAX_TOOL_LOOPS`，最后是兜底文案。

**旧版本的「2 次 cached 硬停」已经移除**：cached 不再触发 turn abort，不再在 UI 上出现，详见下一节。

---

## 防重复调用（PREVENTION + 隐式回放）

osheep code 的目标是**让模型一开始就不重复调用**，靠的是多层防护，而不是「出现了再警告」。

提示词侧的预防：

- Rule 4「**Never repeat a tool call**」用强语气写，明确告诉模型「调用前先扫描自己上方的输出 + 看 `<recent-tool-calls-this-turn>` 摘要」
- Rule 2「**multi_edit is the default for 2+ edits to the same file**」消除「同文件多次 edit_file 看起来像重复但其实是合法批处理」的灰色地带
- 把「失败的 tool call 不会改变文件系统」「retry 相同 args 必然再次失败」写成 Tool result handling 的一条规则
- `edit_file` / `multi_edit` 失败时后端返回 `可能位置: line A, B, …`，让模型据此 narrow `oldString` 而不是同参重试

runtime 侧的最后一道防护（**对用户和模型都不可见的「隐式回放」**）：

- `toolResultCache` 按 `${tool}::${stableStringify(args)}` 缓存本轮结果
- 命中 cache 时：**不在 timeline 上追加任何步骤**（onToolCall 已加进 pendingSteps 的占位被移除），仅把缓存 payload 作为 tool result 回填进 modelTranscript；模型下一轮看见结果继续做下一步
- 不再设 cached 硬停阈值；`MAX_TOOL_LOOPS = 40` 是外层回路上限，另有 `NO_PROGRESS_LIMIT = 3` 防止连续无真实工具执行的空转

每轮（第 2 轮及之后）runtime 在 apiMessages 末尾注入一段合成 system 消息：

```
<recent-tool-calls-this-turn>
1. read file path/to/x.ts → ok
2. write multi_edit path/to/x.ts (3 edits) → ok
</recent-tool-calls-this-turn>
These calls have already been executed. Their results are in the transcript above. Do NOT re-emit any of them with identical arguments — pick a different next action or finish with <verify>.
```

文本协议下模型容易忘自己刚做了什么（这正是 Claude Code 用原生 tool_use 协议就不会有的问题）。把已执行的工具列出来是补这个缺口最直接的手段，把残留 cached 命中率压到接近 0。

---

## 根因修复协议（TasksState + modelTranscript）

osheep code 的工具循环必须保证模型看见自己上一轮刚刚输出过的内容，否则模型会反复生成同一个 tasks / read / write。runtime 因此维护三份状态：

- `modelTranscript`：本轮发给模型的真实上下文。每次 SSE 结束后，把 assistant 原文追加进去，再追加对应 `tool` 结果；若本轮有 accepted tool，assistant 原文只保留到第一条 tool 结束处，第一条 tool 后未执行的模型输出不会进入下一轮 transcript。
- `TasksState`（运行时接口，源码已统一改名为 `TasksState`；持久化字段 `kind: "plan"` 因兼容旧 session 文件保留，UI / 文档统一用 Tasks）：本轮最新 tasks 的规范化快照。非平凡任务必须先有有效 tasks；没有有效 tasks 时出现 tool call，runtime 不执行工具，而是回传合成 tool result（`[tasks_required]`）要求模型先输出 `<tasks>`。
- `executedTools`：本轮所有实际执行过 / 被 cache 短路过 / 被 deny 过的工具调用序列。下一轮 apiMessages 末尾用它构造 `<recent-tool-calls-this-turn>` 摘要。

工具策略也要降低真实失败率：

- 搜索和验证优先用 `read.search`，不要用 shell `grep` / `findstr`。
- `write_file` 只用于创建新文件或完整内容已知的整文件覆盖；局部修改用 `edit_file`；**同文件多处修改用 `multi_edit`**。
- `edit_file.oldString` / `multi_edit.edits[i].oldString` 必须来自已经读取到的文件内容，且要足够长以唯一匹配；失败后不要同参重试，先 read / search 再换更精确的上下文。后端在 oldString 不存在或不唯一时会返回**候选行号**，模型应据此 narrow，**无须**重新整文件 read。
- `read.file` 的工具结果包含 `path` / `size` / `truncated` / `content`。如果 `truncated=true`，模型不得假设未读取部分的内容。
- `run` 只用于测试、构建、type-check、项目脚本或用户明确要求的命令；**非必要不请求命令**（每次 run 通常要用户审批一次）——能用 `read.file` / `read.list` / `read.search` 拿到的信息就不要 shell（`ls` / `dir` / `cat` / `type` / `pwd` / `echo` / `grep` / `findstr`），也不要重复跑已经跑过、结果已知的命令。`exitCode !== 0` 视为工具失败，模型要读取 stdout/stderr 后调整策略。

---

## edit_file / multi_edit 的 UI 副作用（提示词约束）

两个工具在前端都有**两个**渲染时机：

1. **审批 / 执行前**：模型刚发出 `<tool name="write">{...}</tool>` 时，前端在 timeline 立刻渲染一个**缩略 preview 卡片**（虚线描边、`待审批` 标签）。`edit_file` 显示单段 `-/+`；`multi_edit` 堆叠 N 段。
2. **执行成功后**：替换为后端返回的真实 diff 卡片（实线描边、`+N/-M` 统计、行号）。`multi_edit` 在标题里显示 `(N edits, +总和/-总和)`，body 内堆叠 N 个 mini diff，每个有自己的 `startLine` 与 `+a/-r` 统计。

底部的审批条（`tool-confirm`）也跟着变窄——既然 diff 已经在 timeline 内，审批条只剩**标签 + 一行 args 摘要 + 三个按钮**，不再重复渲染 diff。`multi_edit` 的摘要文案是 `multi_edit <path> (N edits)`。

提示词在 Rule 9 明确告诉模型：

> edit_file / multi_edit results render as inline diff cards in the chat timeline, both BEFORE the user approves and AFTER execution. Do NOT re-quote `oldString` / `newString` in `<thought>` or `<verify>`; a one-line summary is enough.

回传给模型的 tool_result 中也**只保留** `oldString` / `newString` / `startLine` / `added` / `removed`（以及 multi_edit 的 `edits` 数组），不包含整文件 `before`/`after`。

---

## 状态符配色

时间线里的状态符（tool step icon + tasks checkbox）使用如下配色：

| 状态 | 形态 | 颜色 |
|---|---|---|
| running / doing | 脉动圆点 | `#58a6ff`（蓝） |
| ok / done       | 描边 + 勾   | `#3fb950`（绿） |
| err / denied    | 描边 + ✗   | `#d29922`（黄） |
| pending / todo  | 浅描边空圈   | `var(--fg-faint)` |

> `cached` 状态依然保留在 `ChatStep.status` 联合类型里（向后兼容旧 session 文件回放），但 **新的对话不会再产生 cached 步骤**——命中缓存的工具调用对 UI 完全不可见。

样式在 [`frontend/src/workbench/workbench.css`](../../../frontend/src/workbench/workbench.css) 的 `.chat-step__icon--*` 与 `.chat-markdown .markdown-todo[data-state="*"]` 选择器下。改色时两处需要保持一致。

---

## 推理强度（reasoning effort / thinking）

osheep code 支持把推理强度透传给上游模型。强度只对一部分模型有效：

| Provider 协议 | 模型类型 | 透传字段 | 可选值 |
|---------------|---------|---------|--------|
| `openai` | `gpt-5*`、`o1*`、`o3*`、`o4*` 等 reasoning 系列 | `reasoning_effort` | `minimal` / `low` / `medium` / `high` |
| `anthropic` | `claude-3-7-*`、`claude-4-*`、`claude-opus-4*`、`claude-sonnet-4*` 等支持 extended thinking 的模型 | `thinking: { type: "enabled", budget_tokens }` | `off` / `low` / `medium` / `high`（映射为 `0 / 4k / 16k / 32k` budget） |
| 其它（gpt-4o、claude-3-5、其它厂家） | — | — | 设置项被隐藏 |

前端的「设置面板」与斜杠菜单的「Model」选项里都提供推理强度的下拉。模型不支持时下拉自动隐藏。

---

## 当前阶段不做

- 工具白名单 / 黑名单（仅通过 auto-allow 控制类型粒度，不细化到具体命令）
- 子 Agent / 嵌套对话
- 模型自我反思 / chain-of-thought 隐藏
- 跨多文件的 multi_edit（一次 tool call 同时改若干 path）
- 切换到原生 `tool_use`（Anthropic）/ `tool_calls`（OpenAI）协议——这是更深层修复重复调用的方向，但当前阶段先用 multi_edit + 已调用摘要 + UI 隐藏覆盖 90% 场景
