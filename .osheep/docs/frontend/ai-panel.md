# AI 面板 / osheep code

## 目标

把工作台右侧栏改造为 AI 协作主入口（命名 **osheep code**，高仿 Claude Code 的交互范式），承载 osheep 后续的需求 → 计划 → 执行 → 验证全流程。

osheep code 不是「单轮问答助手」。它在收到一条用户消息后，会像 Claude Code 一样：

1. 先输出 **任务清单（tasks）**——把任务拆成 Markdown 复选框列表
2. 然后进入 **多轮思考（thought）+ 工具调用（tool-call）** 循环
3. 每完成一个 todo 重新发出 `<tasks>`，把状态从 `- [ ]` 推进到 `- [~]` / `- [x]`
4. 需求模糊时输出 `<ask>` 询问用户——前端在 composer 上方的「审批框位置」渲染按钮组 + 「其他」（手动输入）；用户点选后该文本变成新一轮用户消息
5. 最后输出 **总结 / 验证（verify）**——确认是否达成目标，列出未完成项

> 「任务清单」对应的内部 step 名称是 `kind: "plan"`，仅保留作为数据持久化字段名以兼容旧 session 文件。**UI、提示词、文档**一律使用「Tasks / 任务清单」名称。

每一轮思考在对话流里呈现为一个独立的「步骤行」，**步骤之间用 1px 灰色细线衔接**，表示这是一段连续的思考过程；最末步骤在生成时配有「shimmer 思考动画」。工具调用紧跟其后并带状态图标。

## 视觉与配色基线

osheep code 的所有视觉元素都基于 **VS Code Dark Modern 配色变量**（见 `frontend/src/styles.css` 的 `:root`），不再使用蓝/橙/绿/黄等饱和色块作为强调：

- 强调色统一走 `var(--accent)`（VS Code 蓝 `#0078d4`），不再硬编码 `#5db0ff` / `#4ea1ff` / `#79c0ff`
- 状态图标采用配色区分：`✓` 绿（`#3fb950`） / `✗` 黄（`#d29922`） / 蓝色脉动点（`#58a6ff`），背景去色仅留描边
- 助手 chip 圆点不使用品牌色（橙/蓝），统一为 `var(--fg-muted)`
- 「正在生成」shimmer 仅用 `rgba(255,255,255,0.06)` 级别的低亮度白色掠过，不引入彩色高光
- 「thinking」徽章不带蓝色背景，只用一个细的描边 chip + 一个无色脉冲点
- 工具确认条不使用红色背景/红色边框，按 VS Code 信息条风格使用 `var(--bg-shell)` + 顶部 1px `var(--border-edge)` 即可

---

## 顶层布局

右侧栏整体仿 Claude Code 侧边栏的视觉风格，**顶部有两个 tab**：

```
┌──────────────────────────────────────────┐
│ OSHEEP CODE                              │  ← 顶部品牌行
├──────────────────────────────────────────┤
│ [ osheep code ]  [ 维护 ]                │  ← tab 切换：编写 / 维护
├──────────────────────────────────────────┤
│ + New session                            │
├──────────────────────────────────────────┤
│ 🔍 Search sessions…                       │
├──────────────────────────────────────────┤
│ Add AI settings and agent …       1h     │
│ Fix Git UI and shell encoding…    3h     │
│ Integrate VSCode-like search…     6h     │
│ Fix terminal panel persistence…   8h  🗑  │
│ Polish editor features: tabs…    17h     │
│ Deploy Monaco editor in fro…     23h     │
│ 设计 AI 驱动的 Web 版 VSCode…       1d     │
└──────────────────────────────────────────┘
```

- **osheep code** tab：本文档下方主要描述的对话栏（编写）
- **维护** tab：占位，当前阶段仅显示「即将上线」提示

切换 tab 不影响中央编辑区已打开的对话 Tab。

---

## 后台运行（关闭 Tab 不中断）

osheep code 的对话由一个**模块级单例 runtime**（`chat-runtime.ts`）持有，而非 `ChatTab` 组件的内部 state。这样做的目的：

- 用户在 AI 正在执行任务的过程中关掉中央编辑区的对话 Tab，**后台流不中断**，工具调用循环继续进行
- 用户随后重新打开该对话（通过右侧栏的会话列表）后，会立刻看到当前最新进度
- 整个工作台关闭浏览器才会断开（一次性流，没有跨刷新恢复）

实现要点：

- `ChatRuntime` 内部维护 `Map<sessionId, TurnState>`：
  ```ts
  interface TurnState {
    sessionId: string;
    workspaceId: string;
    pendingSteps: ChatStep[];
    status: "idle" | "running" | "awaiting-confirm" | "error";
    pendingConfirm: PendingToolConfirm | null;
    error: string | null;
    abortRef: AbortController | null;
    busy: boolean;
    listeners: Set<() => void>;
    queued: SendPayload | null;
  }
  ```
- React 组件通过 `useSyncExternalStore`（或自定义 `useChatTurn(sessionId)`) 订阅
- `ChatTab` mount → 注册 listener；unmount → 仅注销 listener，不 abort
- 真正取消需要用户在 composer 上按「停止」按钮，对应 `runtime.stop(sessionId)`
- Tool 确认弹窗也由 runtime 持有；ChatTab 重新挂载时若发现 `awaiting-confirm` 状态，再次显示确认条
- 关闭浏览器 / 刷新页面：runtime 随页面销毁，未完成的工具回路丢失（与之前一致，本阶段不做跨刷新恢复）

---

## osheep code tab（编写）

### 顶部标题行
- 文案：`OSHEEP CODE`（全大写，受 Claude Code 启发但保持 osheep 命名）
- 字号小，字色 muted，全大写并轻微 letter-spacing

### 新建按钮
- 整行宽度，文案 `+ New session`
- 蓝色调（accent），不带边框/不带底色，hover 时浅色背景
- 未打开工作区时禁用

### 搜索框
- 始终可见，前置 🔍 图标，placeholder `Search sessions…`
- 输入后按 `title` 子串过滤（大小写不敏感）

### 会话列表
- 每条会话占一行：左侧标题（单行省略），右侧相对时间（如 `34m`、`5h`、`1d`）
- 顺序：按 `updatedAt` 倒序
- 后台正在跑的会话：标题前点亮一个**绿色脉冲点**作为状态指示
- 点击：在中央编辑区打开一个 Tab，path 为 `__chat__:<id>`
- hover 在时间数字之后展开 重命名 ✎ 与 删除 🗑（删除二次确认）
- 选中态：当前在中央编辑区激活的对话会有浅色背景高亮

### 会话标题
- 新建时默认 `新对话`
- 用户第一条消息发送后，若标题仍为默认，自动取这条消息前 24 个字符作为标题

---

## 维护 tab（占位）

```
┌──────────────────────────────────────────┐
│ 维护功能正在筹备中                          │
│                                          │
│ 未来阶段将提供：                            │
│ • 长期会话与记忆库                          │
│ • 规则 / 工作流模板                         │
│ • 自动化任务（计划运行）                     │
└──────────────────────────────────────────┘
```

切换到该 tab 仅展示静态提示卡片，不发起任何请求。

---

## 中央对话 Tab（osheep code 会话）

每个会话 Tab 模仿 Claude Code 中央对话区域：

- 整体背景与编辑器一致，无外框
- 上方为「消息时间线」，每个节点是一个「步骤行」（思考 / 工具调用 / 文本）
- 步骤之间在左侧时间线轴上以 1px 灰色细线连接（持续思考）
- 底部固定一个**圆角输入卡片**

```
┌──────────────────────────────────────────────────────────┐
│  you                                                       │
│  把 frontend/src/workbench/api.ts 里的所有 console.log     │
│  删掉                                                     │
│                                                          │
│  osheep code                                              │
│  ● Tasks                                                 │
│    ☐ 读取目标文件                                          │
│    ☑ 检查所有 console.log 出现位置                          │
│    ◐ 删除并保存                                            │
│    ☐ 验证无残留                                            │
│  ╎                                                        │
│  ● Thought  让我先把文件内容读出来                          │
│  ╎                                                        │
│  ✓ Read     frontend/src/workbench/api.ts (412 lines)    │
│  ╎                                                        │
│  ● Thought  共匹配到 3 处，逐一删除…  ▎(shimmer)            │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  ╭────────────────────────────────────────────────────╮  │
│  │ 输入消息……                                          │  │
│  │                                                    │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ +   /     Anthropic / claude-opus-4-7 · high  ↑   │  │
│  ╰────────────────────────────────────────────────────╯  │
└──────────────────────────────────────────────────────────┘
```

### 步骤行（time-line item）

每个步骤行由 **状态图标 + 类型标签 + Markdown 渲染的内容** 组成：

| 状态图标 | 用法 |
|---------|------|
| ● 灰色实心点 | 普通文本（thought / verify / 助手自然语言段落） |
| ☐ 浅描边 / ☑ 绿色对勾 / ◐ 蓝色脉动点 | Tasks 的 checkbox（未做 / 已完成 / 进行中） |
| ✓ 绿色对勾（`#3fb950`） | 工具调用成功（read/write/run 等返回 0 / 非错误） |
| ✗ 黄色叉（`#d29922`） | 工具调用失败 / 越权拒绝 |
| ↻ 中性描边（`var(--fg-muted)`） | 旧 session 回放时的同轮重复工具调用缓存命中标记（新对话不会产生） |
| ● 蓝色脉动点（`#58a6ff`） | 工具调用进行中（loading） |
| ◇ 描边菱形（`var(--accent)`） | 模型发起的结构化询问（`<ask>`，前端在底部渲染选项面板） |
| shimmer 渐变 | 当前流式生成中的最后一个 step |

类型标签（紧跟图标，单词 + 等宽小字）：

- `Tasks`：本轮任务清单；body 按 Markdown 渲染，`- [ ]` / `- [~]` / `- [x]` 行变成可视 checkbox（内部数据字段仍叫 `plan`，UI 一律显示 `Tasks`）
- `Thought`：一次自然语言思考片段，body 按 Markdown 渲染
- `Read` / `Edit` / `Write` / `Run` / `Search`：工具调用，后面接对象描述与摘要
- `Ask`：模型抛给用户的结构化问题；body 渲染问题文案，底部还会显示一个固定的选项面板（与审批框同位置）
- `Verify`：最后的验证结论，body 按 Markdown 渲染

为了避免 `Tasks` / `Thought` / `Verify` 三类纯文本步骤视觉趋同（同一个圆点），它们在图标侧使用不同形态：

| 类型 | 图标形态 | 颜色 |
|---|---|---|
| Tasks | 实心圆点（最大） | `var(--accent)` |
| Thought | 小圆点 | `var(--fg-muted)` |
| Ask | 描边菱形 | `var(--accent)` |
| Verify | 描边对勾 | `#3fb950` |

这与 Claude Code「计划 → 思考 → 验证」三段式的视觉节奏保持一致，用户扫一眼就能区分阶段。

工具调用行**可折叠**——默认折叠成单行摘要（路径 / 命令 / 行数 / 退出码），点击展开查看 stdout / stderr / 通用 result。

##### `edit_file` / `multi_edit` 工具行：单张完整文件 diff + 完整 diff Tab

`Edit` 这一类工具行不再渲染原始 JSON，也不再堆叠多个局部 diff 块，改为「单张完整文件 unified diff + 跳转完整 diff」复合形态，参照 Claude Code 在终端里展示文件改动的方式。**diff 在审批前后都直接渲染在 timeline 里**，让用户在审批条按下「允许」之前就能先看清改动内容：

| 状态 | 卡片来源 | 视觉 | 标签 |
|---|---|---|---|
| `running`（等待审批 / 执行中）| 从 `args.oldString` / `args.newString`（`edit_file`）或 `args.edits`（`multi_edit`） | 虚线描边 | `待审批` |
| `ok`（执行成功） | 后端 `diff.{ oldString, newString, startLine, added, removed, before, after }`（`edit_file`）或 `diff.{ edits[], added, removed, before, after }`（`multi_edit`） | 实线描边 | `+N / -M` |
| `cached`（旧 session 回放） | 与 `ok` 同 | 实线 + 中性图标 | `cached` |
| `err` / `denied` | 不渲染 diff 卡 | 仅工具头红/黄状态 | — |

> 新的对话**不会再生成 cached 步骤**，详见后面「轮次上限与重复调用熔断」段落。`cached` 这一行仅在打开旧 session 文件时出现。

- **缩略 diff 默认展开**——不需要再点击工具头才能看到
- 卡片右上角有一个折叠按钮 `▾`，用户嫌噪音的时候可以单独折掉某个 step
- `edit_file` / `multi_edit` 顶部一行 `path` + `:startLine`（若有）+ `(N edits)`（multi_edit）+ `+总和/-总和` + 「完整 diff →」按钮
- 紧接一块**单张 unified diff 卡片**——显示整个文件的改动（真实行号 + 上下文行 + 长段未改动区域折叠为 `⋯ N 行未改动`），而非多个局部 `-/+` 片段堆叠
- 卡片高度被限制（默认最多 60 行），超出滚动；不在这里塞整文件 diff
- 点击「完整 diff →」 → 在中央编辑区新增一个 **AI Diff Tab**（`__ai-diff__:<sessionId>:<stepId>`），左侧 `diff.before`、右侧 `diff.after`（`multi_edit` 显示的是整批 edits 应用后的最终内容）

实现要点：

- 后端在 `edit_file` 的成功响应里附带 `diff.{ oldString, newString, startLine, endLineBefore, endLineAfter, added, removed, before, after }`；`multi_edit` 附带 `diff.{ edits[], added, removed, before, after }`（详见 [`backend/ai-chat-api.md`](../backend/ai-chat-api.md)）
- 前端 chat-runtime 把这份结构原样塞进 `step.result`；回发给模型前剥掉 `diff.before` / `diff.after`，避免 token 浪费
- 工具行的展开 UI 与 AI Diff Tab 都直接从 `step.result.diff` 取数据，不再 fetch 后端
- pending 状态的 preview 卡片由前端 `EditPreviewCard` / `MultiEditPreviewCard` 渲染，数据只来自 tool args，不依赖任何后端响应
- 旧会话（没有 `diff` 字段）退化为原来的 JSON 文本展示
- unified diff 算法在 `frontend/src/workbench/file-diff.ts`：LCS 行级 diff + 前后缀公共段裁剪 + 上下文折叠（默认保留改动行前后各 3 行，其余折叠为 gap 行）+ 最多 60 行截断

##### `Run` 工具行：in/out 卡片（命令 + stdout/stderr）

`Run` 工具行不再仅展示原始 JSON，改为「in/out 卡片」形态，参照 Claude Code 在终端里展示命令执行的方式：

| 状态 | 卡片来源 | 视觉 |
|---|---|---|
| `running`（等待审批 / 执行中）| 从 `args.command` / `args.cwd` | 虚线描边 + `运行中…` / `待执行` 标签 |
| `ok` / `err`（执行完成） | 后端 `{ stdout, stderr, exitCode, signal, durationMs }` 或 `{ ok: false, message }` | 实线描边 + exit badge（绿色 `exit 0` / 红色 `exit N` / `失败`） |

- **in/out 卡片默认展开**——不需要再点击工具头才能看到
- 卡片右上角有一个折叠按钮 `▾`
- head 显示 `$ command` + duration（如 `1.2s`）+ exit badge
- body 显示 cwd（若有）+ stdout + stderr（stderr 单独标注 `stderr` label，红色文字）
- stdout/stderr 各自最多显示 200 行，超出显示 `… 还有 N 行`
- 无输出时显示 `（无输出）`
- pending 状态由 `RunPreviewCard` 渲染，仅显示 `$ command` + cwd + `运行中…` / `待执行` 标签

##### `Read` / `Search` 工具行仍保留点击展开

它们的展示密度本来就低（一行摘要 + 一段输出），保留 click-to-expand 即可。只有 `edit_file` / `multi_edit` / `run` 走默认展开，因为「改动」和「命令执行」对用户的关注度远高于「读取」。

#### 时间线视觉

- 左侧 18px 列摆放圆形状态图标
- 图标之间用一条 1px `var(--border)` 细线相连
- 最新生成中的 step 上覆盖一层 1.2s 循环的 `linear-gradient` shimmer
- Plan 内部 todo 行：
  - `- [ ]` → 空心方框
  - `- [~]` → 半填充方框 + 文字带「(in progress)」灰色后缀
  - `- [x]` → 实心勾选方框 + 文字加 line-through

#### Markdown 渲染

osheep code 的所有自然语言步骤都按 GitHub-flavored Markdown 渲染：

- Tasks / Thought / Verify / Ask / 自由 text 共用 `<ChatMarkdown>` 组件
- 内部使用 `marked` + `DOMPurify`，与 `MarkdownPreview` 共享配置
- 代码块自动等宽字体；行内代码使用浅色背景小 chip
- todo checkbox 使用样式 hook：`.markdown-todo[data-state="done"|"doing"|"todo"]`
- 工具调用的输出仍走原始 `<pre>` 等宽块，不走 Markdown

#### Tasks 块的渲染规则（重要）

后端 SSE 解析 `<tasks>` 块时，**每行都按完整的 markdown checkbox 形态保留**（包括前导 `- ` 和 `[ ]` / `[~] ` / `[x] `），传给前端的 `items` 数组里**不再做任何前缀剥离**。这是因为：

- 旧实现会把 `- [ ] 任务` 剥成 `[ ] 任务`，再在前端拼回 `- [ ] [ ] 任务` 给 marked，导致页面上同时出现一个真实的 checkbox **和**一段字面量 `[ ]` 文本
- 新实现：parser 只过滤空行；前端 `StepRow` 直接把 items 用 `\n` 连接交给 `ChatMarkdown`，由 marked 的 GFM task-list 解析渲染
- 兼容：parser 同时识别 `<tasks>` 与 `<plan>`，前缀剥离的旧 session 文件也会被前端按「未做」补全成 `- [ ] 文本`

### Composer（底部输入卡片）

- 圆角矩形卡片，深色背景较输入框区域略浅，1px border + 轻微 box-shadow
- 上半：多行 textarea，无边框、透明背景
- 下半：操作行
  - 左侧：`+`（附加上下文 / 文件 — 当前阶段为占位）、`/`（**斜杠菜单**，详见下方）
  - 中间：**模型 chip**——展示当前 `Provider / Model · Effort`，点击展开模型选择器（与斜杠菜单的 Model 子菜单一致）
  - 右侧：**仅一个发送按钮**

- 发送按钮：纯圆形（30×30）箭头按钮（↑），始终位于卡片右下角
- 行为：
  - `Enter` 发送，`Shift+Enter` 换行
  - **任务运行中也可以发送**：只要输入框里有非空文字，发送按钮就处于可点击状态——点击会先停止当前任务，再把新消息作为新一轮发送（不再排队、不再做并发拼接）
  - 当输入框为空且任务正在运行时，发送按钮显示为 ■（停止），点击仅停止；`Esc` 等价
  - 当输入框为空且任务空闲时，发送按钮禁用
  - 未选择 Provider/Model 时禁止发送，按钮 hover 文案「请先通过 / 菜单或设置中选择 Provider / Model」

### 时间线自动滚动

- 默认行为：**仅当用户当前确实位于时间线底部**才随新 osheep-code 状态自动滚到底（容差 ≈ 8px）；用户向上滚阅读历史时不会被拉回
- 触发条件是「对话状态签名」变化：session 消息数量 / 最后一条消息 / pending step 内容或状态 / pending confirm 变化。单纯布局变化、diff 展开折叠、确认条高度变化不会触发自动滚动
- 发送时不设置特殊贴底规则：用户如果在历史中发出新消息，视图不会被拉到底；只有用户自己回到底部后才重新跟随
- 为了处理 Markdown / diff 异步渲染导致的高度晚到，自动滚动会在同一个状态事件后延迟 1-2 帧再次贴底；若用户期间向上滚动，后续帧不会继续拉回
- 切换 Tab 或重新打开会话时不自动贴底；滚动状态由用户实际位置决定

### Provider · Model 选择（斜杠菜单 + chip）

- **设置页保留默认值的配置入口**（设置 → AI → 默认对话模型），用作初次打开工作区的种子
- **斜杠菜单 / chip 提供即时切换入口**：用户可以在不离开对话的情况下切换 Provider/Model 与推理强度
- 模型列表展示形式：扁平 `provider/model` 行，而不是「先选 Provider 再选 Model」的两栏式
- 选中的 (providerId, model, effort) 会写回 `.osheep/settings.json` 的 `ai.defaultProviderId` / `ai.defaultModel` / `ai.reasoningEffort[providerId+model]`
- 切换会作用于下一次发送，不重写历史消息

#### 推理强度（Reasoning effort）

- 仅对支持 reasoning / extended thinking 的模型显示
  - OpenAI 协议：`gpt-5*` / `o1*` / `o3*` / `o4*` → `minimal / low / medium / high`
  - Anthropic 协议：`claude-3-7-*` / `claude-4-*` / `claude-opus-4*` / `claude-sonnet-4*` → `off / low / medium / high`（映射到 `thinking.budget_tokens`：0 / 4096 / 16384 / 32768）
  - 其它模型：不显示 effort 控件
- 默认值：`medium`（OpenAI）/ `low`（Anthropic）
- 持久化：`ai.reasoningEffort` 是一个 map：`{ "<providerId>::<model>": "low|medium|high|minimal|off" }`
- 前端在发送时根据当前模型是否支持把对应字段加进 `/ai/chat/stream` 请求体

### 斜杠菜单 `/`

仿 Claude Code 的 `/` 菜单，点击 `/` 图标或在输入框首字符输入 `/` 时弹出。

**弹出锚点**：菜单使用 `position: absolute` 相对 `/` 图标按钮所在的左侧操作组（`.chat-composer__row-left`），向上方对齐，**不会**漂浮到整个工作台顶部。

```
Model
  ● Anthropic / claude-opus-4-7              ✓
    Anthropic / claude-sonnet-4-6
    OpenAI / gpt-4o
    OpenAI / gpt-5-mini
    …
  Reasoning effort: [ off | low | medium • high ]    ← 模型支持时才显示

Context
  Attach file…              (敬请期待)
  Mention file from this project…   (敬请期待)
  Clear conversation
  Rewind                    (敬请期待)

Tools
  Auto-allow commands…
  Add MCP server…           (敬请期待)

Settings
  Open settings…            ← 跳转到设置页（修改 Provider/API Key 等）
```

菜单顺序：**Model 在最上**（最常用），Tools 在最下。可用键盘 ↑/↓ 选中，`Enter` 确认。

### 自动权限（Auto-allow commands）

osheep code 默认对每个工具调用都会**弹窗征求用户同意**。用户可以把若干工具类型加入白名单，加入后该类调用直接执行不再弹窗。

设置面板（点击 `Auto-allow commands…` 后弹出在 composer 上方）：

```
┌─────────────────────────────────────────────────┐
│  🛡  自动执行的命令类型                            │
├─────────────────────────────────────────────────┤
│  分组按调用风险递增排列：                          │
│                                                 │
│   读取                                           │
│   ☑  Read 文件 / 列目录 / 搜索                    │
│                                                 │
│   写入                                           │
│   ☐  Write 写入 / 创建 / 删除 / 重命名             │
│                                                 │
│   网络                                           │
│   ☐  Network probe — curl / wget / ping / dig    │
│                                                 │
│   安装                                           │
│   ☐  Install — npm i / pnpm / pip / brew / apt   │
│                                                 │
│   Git                                            │
│   ☐  Git — git status / log / diff / branch ...  │
│                                                 │
│   测试 / 构建                                     │
│   ☐  Test — npm test / vitest / pytest / make    │
│                                                 │
│   其它命令                                        │
│   ☐  Run other — 任意 shell 命令                  │
├─────────────────────────────────────────────────┤
│ 未勾选的类型在被调用前会弹出确认。                  │
│           [ 取消 ]  [ 保存 ]                     │
└─────────────────────────────────────────────────┘
```

- 设置持久化到 `.osheep/settings.json` 的 `ai.autoAllow`：
  ```json
  {
    "ai": {
      "autoAllow": {
        "read": true,
        "write": false,
        "runNetwork": false,
        "runInstall": false,
        "runGit": false,
        "runTest": false,
        "runOther": false
      },
      "defaultProviderId": "prov_abc",
      "defaultModel": "claude-opus-4-7",
      "reasoningEffort": { "prov_abc::claude-opus-4-7": "high" }
    }
  }
  ```
- 兼容旧字段 `autoAllow.run` —— 读入时若 `run=true`，自动展开为 `runNetwork/runInstall/runGit/runTest/runOther` 同时为 true
- 默认：`read=true`，其余均为 false（保守）
- 工具调用前端会根据 `args.command` 做分类（pattern 见 `frontend/src/workbench/run-classify.ts`），决定走哪个 autoAllow 键
- 视觉：每组用浅色 label 分隔；checkbox 与说明文字水平排列；hover 行有浅高亮；面板带渐变阴影与 12px 圆角

### 工具调用确认弹窗

当 AI 请求执行**未列入白名单**的工具时，**消息流暂停**，在 Composer 正上方滑出一个简洁的确认条：

```
┌──────────────────────────────────────────────────────────┐
│  osheep code 想要 运行命令（Network）                     │
│  $ curl https://api.example.com/health                   │
│                                          [ 是 ] [ 否 ] [ 其他 ] │
└──────────────────────────────────────────────────────────┘
```

按钮语义（**与 v1 不同**：去掉了「始终允许 X」与红色「拒绝」按钮，按钮颜色统一收敛到中性灰）：

| 按钮 | 行为 |
|---|---|
| **是** | 允许这次工具调用，继续本轮工具循环。**不会**写回 autoAllow——"始终允许"只能在斜杠菜单的 `Auto-allow commands…` 面板里配置 |
| **否** | 拒绝这次调用，AI 收到 `[denied by user]` 信号 |
| **其他** | 把按钮组就地替换为单行 textbox + 「发送」按钮；用户输入文字后，AI 收到 `[denied by user: <用户输入>]`，相当于带反馈的否决——告诉模型「按这个方向重新做」，不需要打断当前 turn |

视觉规范（**配色基线刷新**）：

- 不使用红色背景与红色边框，也不使用任何高饱和度强调色——确认条**整体灰阶**，避免与真正的错误条混淆，也避免在密集对话中视觉抢眼
- 背景使用 `var(--bg-shell)`，顶部一条 1px `var(--border-edge)`，圆角 6px
- 三个按钮（是 / 否 / 其他）统一使用中性描边样式 `tool-confirm__button`（透明底 + `var(--border-edge)` 描边 + `var(--fg-default)` 文字，hover 浅灰）——不再用 `primary-btn` 实心填充或 `danger-btn` 红色，确认条没有任何按钮带强调色或危险色
- **`tool-confirm--compact` 变体**：当工具是 `edit_file` 或其它高密度调用时，diff / 详细信息已经在对话 timeline 内联渲染，确认条采用**横向布局**——左侧标题 + 一行 args 摘要，右侧按钮组，整体高度更低，不重复展示 diff
- 命令 / 参数摘要使用等宽字体浅灰背景的 `<pre>`，限制最大高度 + `overflow-x: auto`
- 对 `edit_file` 工具，**diff 不再渲染到确认条里**，而是渲染到上方 timeline 的 tool step 里（参见前述 `edit_file 工具行` 段落，pending 状态用虚线 + `待审批` 标签）

用户没回应前消息流冻结；超过 5 分钟无响应视为拒绝。因为 runtime 在后台跑，**确认条状态归属 runtime**——即使关闭再打开 Tab，确认条还在原位。

### Ask 选项面板（结构化询问）

当模型输出 `<ask>{"question":"...","options":["A","B"]}</ask>` 后没有继续调用工具，runtime 会把本轮收尾保存到 session，并在 composer 上方渲染一个与「工具确认弹窗」同位置同尺寸的选项面板（组件 `AskPromptBar`）：

```
┌──────────────────────────────────────────────────────────┐
│  你偏好哪种主题风格？                                       │
│                                                          │
│  [ A. 暗黑（VS Code Dark Modern） ]                       │
│  [ B. 经典（GitHub Light） ]                              │
│  [ 其他 ]                                                 │
└──────────────────────────────────────────────────────────┘
```

行为：

- 问题文案作为标题渲染；选项按钮使用与确认条一致的中性 `tool-confirm__button` 样式（外加 `tool-confirm__choice` 限宽省略），带序号前缀 `A. / B. / C. / D.`，最多 4 个
- 点击某个选项 → 立刻把该选项文本作为**新一轮用户消息**调用 `chatRuntime.send()`，`AskPromptBar` 随之消失
- 点击 **「其他」** → 标题下方就地展开 textbox + 「发送」按钮，用户输入文字按 `Enter` / 点「发送」即作为新一轮用户消息发送（手动输入对 AI 的指示）
- 模型在 `options` 里**不应**预留 `其他`——前端 UI 自动追加；`options` 不足 2 个时 parser 视为无效，退化为普通文本段落
- 与工具确认条共享同一个位置，但两者不会同时出现：模型要么发起 ask 等待用户选择（turn 已结束、无 pending tool），要么处于工具审批中（turn 仍在进行）

判定：前端读取 session 的最后一条 assistant 消息——若其 `steps[]` 数组的**最后一个**有效步骤是 `kind: "ask"`，且后续没有用户消息，则渲染 `AskPromptBar`。一旦用户响应（任何方式），新消息追加进 messages，`AskPromptBar` 隐藏。

---

## 流式协议

LLM 回复采用 **SSE（Server-Sent Events）** 流式推送。后端只透明转发上游的 `delta` / `done` / `error`；osheep code 的 `<tasks>` / `<thought>` / `<tool>` / `<ask>` / `<verify>` 标记由前端 runtime 从原始 delta 流里解析，详见后端文档 `ai-chat-api.md`。

前端在 parser 回调里维护当前会话的 `steps[]`（与 `messages[]` 并列）：

- 解析到 `<tasks>` / `<plan>`（旧名兼容） → 更新本轮唯一 `step: { kind: "plan", items: [...] }`，body 中的复选框结构由 markdown 解析；UI 标签显示 `Tasks`
- 解析到 `<thought>` → 新增 `step: { kind: "thought", text }`，**整个 thought 节点原子渲染**（parser 缓冲完整 `<thought>...</thought>` 内容，在闭合标签或下一个标签开始时一次性输出，不做 token 级流式追加）
- 解析到 `<tool>` → 新增 `step: { kind: "tool", tool, args, status: "queued" }`
  - 未授权时保持 `queued` 并切到 `awaiting-confirm`；用户允许后、真正调用后端工具前才改为 `running`
  - 工具返回后 → 更新该 step `status: "ok" | "err" | "denied"`（`cached` 状态仍保留在类型联合里以兼容旧会话回放；新对话里的重复调用会被静默移除）
- 解析到 `<ask>` → 新增 `step: { kind: "ask", question, options }`；后续在 composer 上方渲染 `AskPromptBar`
- 解析到 `<verify>` → 新增 `step: { kind: "verify", text }`
- 未标记 delta → 追加 / 合并为 timeline 内的 `step: { kind: "text" }`，不再存在独立的底部文本气泡；所有可见内容都按步骤顺序进入同一条 timeline
- 收到后端 `event: done` → 关闭当前 SSE；若本轮解析到 tool，则执行工具并继续下一次 SSE；若解析到 `<ask>` 而无 tool，则按「正常结束」收尾（不算 earlyGiveUp）

**Thought 原子渲染的实现**：

- `TagStreamParser` 在 `feed(chunk)` 开头调用 `flushReasoning()`，把上一轮缓冲的 reasoning 块（如果有）通过 `onThought(id, fullText)` 一次性输出
- `feedReasoning(chunk)` 仅累积 reasoning delta 到 `accReasoning`，不触发任何回调
- `onInTagChunk()` 对 `<thought>` 标签内的内容仅累积到 `accInTag`，不再流式调用 `onThoughtDelta`
- `finish()` 在流结束时调用 `flushReasoning()` 并处理未闭合的 `<thought>` 标签
- 结果：每个 thought 节点在 UI 上「瞬间出现」（等待完整内容，然后一次性渲染），而非逐字符流式显示；自由文本（未标记 delta）仍保持流式（在 `<` 边界处输出）

### 工具调用的执行回路

osheep code 的工具调用走的是**前端代理 + 后端执行**模式：

1. 模型在流里输出 `<tool>`（工具名 + 参数），前端 parser 转成 tool call
2. Claude Code 式节奏：**每个 SSE 响应最多接受一个 tool**。模型若在同一段输出里继续写第二个 `<tool>` 或后续步骤，UI 与执行层都会忽略，下一步必须等工具结果回来后由下一轮决定
3. runtime 检查 `autoAllow`（按 run-classify 的分类键），未授权则把状态切到 `awaiting-confirm` 并广播；此时 tool step 仍是 `queued`，不显示 running 动画
4. 同意后 runtime 调用对应后端 API（`/api/workspaces/:id/ai/exec/read|write|run`），调用开始前才把该 step 改为 `running`
5. 拿到结果后，runtime 把本次模型原始输出追加进 `modelTranscript`，再追加 `tool_result`，并通过**第二次** `POST /ai/chat/stream` 继续流
   - 若本轮包含 tool，追加进 `modelTranscript` 的 assistant 原文会被截断到**第一条 accepted tool 结束处**；同一响应里第一条 tool 后面的未执行内容不会进入下一轮上下文
5. 模型基于结果决定下一步：再思考、再调工具、或输出 verify+done

详细协议见 `.osheep/docs/backend/ai-chat-api.md`。

### TasksState 与 modelTranscript（执行约束）

runtime 不能只把 tool result 塞回模型上下文；它必须保留本轮模型自己的原始输出，否则模型下一轮看不到刚刚发过的 tasks / tool call，会重复 tasks 和重复 read。当前执行回路维护三份状态：

- `modelTranscript`：本轮真实发送给模型的上下文。初始化为历史消息 + 本次 user；每次 SSE 结束后追加 assistant 原文，再追加 tool result。若本轮有 accepted tool，assistant 原文会截断在第一条 tool 结束处，避免模型在下一轮「记住」同一响应里未执行的后续 tool / 文本。
- `TasksState`（运行时维护当前 tasks 状态的接口，源码已统一改名为 `TasksState`；只有持久化到 session 的 step 字段名 `kind: "plan"` 因兼容旧会话保留）：本轮最新 tasks 的规范化快照。非平凡任务必须先有有效 tasks；没有有效 tasks 时出现 tool call，runtime 直接拒绝执行并回传合成 tool result（`[tasks_required]`），要求模型先输出 `<tasks>`。
- `executedTools`：本轮实际执行、拒绝、或缓存短路的工具序列。第 2 轮起作为 `<recent-tool-calls-this-turn>` system 摘要追加给模型，降低重复调用率。

Tasks 渲染上保留状态变化快照：相同 tasks 被忽略；状态变化时追加新的 tasks step，让用户像 Claude Code 一样看到 todo 从 `- [ ]` 推进到 `- [~]` / `- [x]` 的过程。最新 tasks 仍是执行约束里的权威快照。

### 轮次上限与重复调用熔断

`MAX_TOOL_LOOPS = 40`。模型耗尽上限、或提前给出 tasks 但没有 verify / ask 时，runtime **不再静默退场**，而是给 timeline 追加一条合成 `text` step。runtime 维护两个状态变量来分类：

- `loopsRun`：本轮已经执行的 SSE 循环数（每进入一次 `for (loop ...)` 就 +1）
- `NO_PROGRESS_LIMIT = 3`：连续 N 轮没有任何真实工具执行（全部被 tasks gate 拒绝 / 用户拒绝 / 参数无效 / 重复 cached）时自动停止并追加说明；`earlyGiveUp` 只表示模型本轮无 tool 且无 verify / ask / text

判定顺序（在 `runTurn` 的 try 块尾部）：

1. `userAborted` → 不追加 exit note（用户主动停的）
2. 当前 `pendingSteps` 已经包含 `verify` 或 `ask`，或已有非空 `text` step → 不追加 exit note（这是正常结束）
3. 否则按下表分支：

| 触发条件 | 末尾 step 文案（示例） |
|---|---|
| `earlyGiveUp === true`（优先） | 「**osheep code 提前结束本轮：** 模型这一轮只发出了 tasks / thought / 文本，既没有继续调用工具也没有给出 `<verify>` / `<ask>`。如果任务还没完成，请发送『继续』或下达更具体的指令。」 |
| `loopsRun >= MAX_TOOL_LOOPS` | 「**已达本轮工具调用上限 (40)。** osheep code 跑完 40 轮工具循环仍未给出 `<verify>`。继续请发送『继续』或下达更具体的下一步指令。」 |
| 兜底（不应触发，防御性） | 「**本轮提前结束。** osheep code 跑了 N 轮但没有 `<verify>`。请检查上方的步骤，再下达更具体的下一步指令。」 |

**判定顺序很关键**：`earlyGiveUp` 必须**优先于** `loopsRun >= MAX_TOOL_LOOPS`。原因：循环最后一次迭代如果模型刚好「give up」，`loopsRun` 也会等于 40，但真正应该展示的原因是「模型自己停的」，不是「跑满了 40 轮」。

合成 `text` step 与正常的助手段落同一形态渲染，不弹错误条，也不需要用户去关闭。它本质上是 osheep code 自己对自己的「补丁注释」，不是错误。

> **旧版本的「同一签名 cached 命中 ≥ 2 次硬停」已经移除。** cached 不再触发 turn abort，也不再在 UI 上出现，详见下面「工具失败的根因治理」。

### 工具失败的根因治理

read / write / run 的失败优先按根因处理，而不是仅展示错误：

- read 文件大于 AI 读取上限时返回截断内容和 `truncated=true`，不再因为编辑器文件大小上限直接失败。
- write 的 `write_file` 仅用于完整内容已知的创建 / 覆盖；明显占位符内容（如仅 `...`）会被拒绝，避免误覆盖。
- **同文件多处修改优先用 `multi_edit`**（一次 tool call、一张 diff 卡、原子）；保留 `edit_file` 只用于单点修改。
- 同参 read / write / run 调用会被静默回放上一次结果（UI **不显示**，模型仍收到 cached payload 继续往下做）；不再因 cached 计数硬停。模型下一轮会在 apiMessages 末尾看到 `<recent-tool-calls-this-turn>` 摘要，提示「这些已经做过，不要再调」，从源头避免重复。
- `edit_file` / `multi_edit` 失败后，同参调用同样走静默回放；模型必须先重新 read/search 或扩大 oldString 上下文。
- 搜索验证优先使用 `read.search`，避免 Windows / macOS / Linux shell 命令差异导致 `grep` / `findstr` 失败。
- run 只用于测试、构建或用户明确要求的项目命令；`exitCode !== 0` 在 timeline 中标记为失败，并把 stdout/stderr 回传给模型继续处理。

### 视觉效果

- 助手区域顶部出现一个跳动的小圆点表示「正在生成」
- 当前真正运行中的 step 行有**linear shimmer**（未结束的 thought、`status:"running"` 的 tool、或最后一个正在追加的 text step）；`queued` / `awaiting-confirm` 不显示运行态
- 步骤之间的连接线是 1px `var(--border)` 灰色实线
- 工具调用从蓝色脉动点（running）→ `✓` 绿（ok）/ `✗` 黄（err / denied）切换；cached 状态对新对话静默（既不渲染工具步，也不切换图标）
- 输入框右下的发送按钮在流式期间替换为 ■（停止）按钮
- 发生网络错误时，错误显示在对话顶部，已生成的部分保留
- **AI 一轮结束后若既无步骤也无文本**，前端**不会保存空助手消息**，转而在错误条显示「上游未返回任何内容，请检查模型 ID 与 Base URL」

---

## 提示词与上下文

osheep code 使用**统一系统提示词**（不再使用 Agent 自定义 prompt），见 `.osheep/docs/ai/osheep-code-prompt.md`。

发送一条用户消息时，前端组装 `messages`：

1. 第一条：osheep code 的 system prompt（前端硬编码常量 + 当前工作区元数据注入）
2. 拼接历史 `user` / `assistant` / `tool` 消息
3. 追加本次输入

历史里的 `tool` 消息以 `role: "tool"` 转成 OpenAI 兼容的 `{ role: "tool", tool_call_id, content }`；如果上游不支持 `tool` 角色，后端会降级为 `role: "user"` 加 `[tool_result] ...` 前缀。

上下文记忆即「整条历史每次都重发」，当前阶段不做截断或摘要。

---

## 会话文件结构

```json
{
  "id": "ses_abc123",
  "title": "新对话",
  "providerId": "prov_abc",
  "model": "claude-opus-4-7",
  "createdAt": 1715000000000,
  "updatedAt": 1715000123456,
  "messages": [
    { "role": "user",      "content": "...", "timestamp": 1715000010000 },
    {
      "role": "assistant",
      "content": "总结性文本",
      "timestamp": 1715000012000,
      "steps": [
        { "kind": "plan",   "items": ["- [x] 读文件", "- [x] 替换", "- [x] 验证"] },
        { "kind": "thought","text": "..." },
        {
          "kind": "tool",
          "tool": "read",
          "args": { "path": "src/api.ts" },
          "status": "ok",
          "result": "..."
        },
        { "kind": "ask", "question": "继续删 console.error 吗？", "options": ["删", "保留"] },
        { "kind": "verify", "text": "完成" }
      ]
    }
  ]
}
```

- `plan.items` 现在是 markdown checkbox 字符串数组（保留前缀以便回放时直接 markdown 渲染）；旧会话只有纯字符串数组，渲染端兼容。字段名 `plan` 是数据持久化历史名，UI 一律渲染为 `Tasks`
- `ask.options` 至少 2 项；前端额外在 UI 追加「其他（手动输入）」入口，模型**不**写到 `options` 里
- `steps` 仅在 `assistant` 消息上出现
- `messages` 不包含 `system`；system 由 osheep code 实时注入

---

## Agent 模块下线

- 左侧活动栏的 **Agent 图标已移除**
- `.osheep/agent/*.json` 数据保留（不主动删除），但前端不再渲染相关入口
- 旧的 `AgentView` 组件保留代码但不再挂载——后续随清理阶段移除
- 后端 `/api/workspaces/:id/agents` 路由暂时保留，前端不再调用

---

## 当前阶段不做

- 多 Agent 并行 / 子 Agent / 子流程编排
- MCP server 接入（在 `/` 菜单中占位）
- Mention file 与 Attach file 真实功能（`+` 与 `/Attach file…` 占位）
- 服务端摘要 / 长上下文压缩
- 删除会话后的「最近删除」回收站
- 维护 tab 的真实功能
- 跨刷新恢复后台对话（关闭浏览器后状态丢失）
