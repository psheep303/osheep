# AI 面板 / osheep code

## 目标

把工作台右侧栏改造为 AI 协作主入口（命名 **osheep code**，高仿 Claude Code 的交互范式），承载 osheep 后续的需求 → 计划 → 执行 → 验证全流程。

osheep code 不是「单轮问答助手」。它在收到一条用户消息后，会像 Claude Code 一样：

1. 先输出 **计划（plan）**——把任务拆成 Markdown 复选框列表
2. 然后进入 **多轮思考（thought）+ 工具调用（tool-call）** 循环
3. 每完成一个 todo 重新发出 `<plan>`，把状态从 `- [ ]` 推进到 `- [~]` / `- [x]`
4. 最后输出 **总结 / 验证（verify）**——确认是否达成目标，列出未完成项

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
    steps: ChatStep[];
    pendingText: string;
    status: "running" | "awaiting-confirm" | "idle";
    pendingConfirm?: { call: ToolCall; resolve: (d) => void };
    abort: AbortController;
    listeners: Set<() => void>;
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
│  你                                                       │
│  把 frontend/src/workbench/api.ts 里的所有 console.log     │
│  删掉                                                     │
│                                                          │
│  osheep code                                              │
│  ● Plan                                                  │
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
| ☐ 浅描边 / ☑ 绿色对勾 / ◐ 蓝色脉动点 | Plan 的 checkbox（未做 / 已完成 / 进行中） |
| ✓ 绿色对勾（`#3fb950`） | 工具调用成功（read/write/run 等返回 0 / 非错误） |
| ✗ 黄色叉（`#d29922`） | 工具调用失败 / 越权拒绝 / 同轮重复调用被去重 |
| ● 蓝色脉动点（`#58a6ff`） | 工具调用进行中（loading） |
| shimmer 渐变 | 当前流式生成中的最后一个 step |

类型标签（紧跟图标，单词 + 等宽小字）：

- `Plan`：本轮任务清单；body 按 Markdown 渲染，`- [ ]` / `- [~]` / `- [x]` 行变成可视 checkbox
- `Thought`：一次自然语言思考片段，body 按 Markdown 渲染
- `Read` / `Edit` / `Write` / `Run` / `Search`：工具调用，后面接对象描述与摘要
- `Verify`：最后的验证结论，body 按 Markdown 渲染

工具调用行**可折叠**——默认折叠成单行摘要（路径 / 命令 / 行数 / 退出码），点击展开查看 stdout / stderr / diff。

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

- Plan / Thought / Verify / 自由 text 共用 `<ChatMarkdown>` 组件
- 内部使用 `marked` + `DOMPurify`，与 `MarkdownPreview` 共享配置
- 代码块自动等宽字体；行内代码使用浅色背景小 chip
- todo checkbox 使用样式 hook：`.markdown-todo[data-state="done"|"doing"|"todo"]`
- 工具调用的输出仍走原始 `<pre>` 等宽块，不走 Markdown

#### Plan 块的渲染规则（重要）

后端 SSE 解析 `<plan>` 块时，**每行都按完整的 markdown checkbox 形态保留**（包括前导 `- ` 和 `[ ]` / `[~] ` / `[x] `），传给前端的 `items` 数组里**不再做任何前缀剥离**。这是因为：

- 旧实现会把 `- [ ] 任务` 剥成 `[ ] 任务`，再在前端拼回 `- [ ] [ ] 任务` 给 marked，导致页面上同时出现一个真实的 checkbox **和**一段字面量 `[ ]` 文本
- 新实现：parser 只过滤空行；前端 `StepRow` 直接把 items 用 `\n` 连接交给 `ChatMarkdown`，由 marked 的 GFM task-list 解析渲染
- 兼容：如果模型偶尔送来不带 `- ` 前缀的纯文本行，前端按「未做」补全成 `- [ ] 文本`

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

- 默认行为：**仅当用户当前已经位于时间线底部附近时**才随新内容自动滚到底（容差 ≈ 80px），用户向上滚阅读历史时不会被拉回
- 强制滚动场景：用户**点击发送按钮**或按 `Enter` 发送新消息时，强制滚动到底，保证看到最新的回复起点
- 切换 Tab 或重新打开会话时不强制滚动，保留用户上次的位置

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
│  osheep code 想要 运行命令（Network）                       │
│  $ curl https://api.example.com/health                   │
│                                                          │
│   [ 始终允许 Network ]   [ 仅这一次 ]   [ 拒绝 ]            │
└──────────────────────────────────────────────────────────┘
```

视觉规范：

- 不使用红色背景与红色边框——避免和真正的错误条混淆
- 背景使用 `var(--bg-shell)`，顶部一条 1px `var(--border-edge)`，圆角 6px
- 不显示 ⚠ 大图标，标题左侧最多一个小图标（与按钮同色）
- 命令 / 参数摘要使用等宽字体浅灰背景的 `<pre>`，限制最大高度 + `overflow-x: auto`，避免一次性把巨大的 `content` 字段全展开
- 按钮顺序固定：「始终允许 X」（主按钮，`primary-btn`）→「仅这一次」（`ghost-btn`）→「拒绝」（`ghost-btn`，文字 `var(--fg-error)`）

- `始终允许 X`：把对应**分类键**加入 `ai.autoAllow`，继续执行
- `仅这一次`：本次允许，不修改设置
- `拒绝`：放弃这次工具调用，AI 收到 `[denied by user]` 信号，自行决定是否换思路

用户没回应前消息流冻结；超过 5 分钟无响应视为拒绝。因为 runtime 在后台跑，**确认条状态归属 runtime**——即使关闭再打开 Tab，确认条还在原位。

---

## 流式协议

LLM 回复采用 **SSE（Server-Sent Events）** 流式推送。osheep code 的协议在原 `delta` 之上扩展了若干事件类型，详见后端文档 `ai-chat-api.md`。

前端在事件循环里维护当前会话的 `steps[]`（与 `messages[]` 并列）：

- 收到 `event: plan` → 新增一个 `step: { kind: "plan", items: [...] }`，body 中的复选框结构由 markdown 解析
- 收到 `event: thought` → 新增 `step: { kind: "thought", text }`，后续 `event: thought_delta` 追加到末项
- 收到 `event: tool_call` → 新增 `step: { kind: "tool", tool, args, status: "running" }`
  - 收到 `tool_result` → 更新该 step `status: "ok" | "err"`，附带 stdout / err
- 收到 `event: verify` → 新增 `step: { kind: "verify", text }`
- 收到 `event: text_delta` → 追加到最后一条 assistant 文本气泡
- 收到 `event: done` → 关闭整个 turn

### 工具调用的执行回路

osheep code 的工具调用走的是**前端代理 + 后端执行**模式：

1. 模型在流里输出 `tool_call`（工具名 + 参数）
2. runtime 检查 `autoAllow`（按 run-classify 的分类键），未授权则把状态切到 `awaiting-confirm` 并广播
3. 同意后 runtime 调用对应后端 API（`/api/workspaces/:id/ai/exec/read|write|run`）
4. 拿到结果后，runtime 通过**第二次** `POST /ai/chat/stream` 把 `tool_result` 作为新的角色 `tool` 追加进 messages，继续流
5. 模型基于结果决定下一步：再思考、再调工具、或输出 verify+done

详细协议见 `.osheep/docs/backend/ai-chat-api.md`。

### 视觉效果

- 助手区域顶部出现一个跳动的小圆点表示「正在生成」
- 当前正在生成的 step 行有**linear shimmer**（1.2s 循环），生成结束后自动消失
- 步骤之间的连接线是 1px `var(--border)` 灰色实线
- 工具调用从蓝色脉动点（running）→ `✓` 绿（ok）/ `✗` 黄（err / denied / 同轮重复调用被去重）切换
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
        { "kind": "verify", "text": "完成" }
      ]
    }
  ]
}
```

- `plan.items` 现在是 markdown checkbox 字符串数组（保留前缀以便回放时直接 markdown 渲染）；旧会话只有纯字符串数组，渲染端兼容
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
