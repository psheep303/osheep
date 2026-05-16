# 终端面板

## 目标

为工作台提供一个嵌入式终端，让用户在不离开 osheep 的情况下执行命令。终端进程跑在**后端服务器**上（不是用户本地）。

---

## 架构

- 前端：xterm.js 渲染（含 ANSI 着色、光标、滚动缓冲、复制粘贴）
- 后端：`node-pty` 启的 PTY 进程，`cwd` 锁在当前 workspace 根
- 传输：每个会话独立 WebSocket，双向 JSON 帧（`input` / `resize` / `output` / `exit` / `error`）
- 详见 [terminal-api.md](../backend/terminal-api.md)

---

## 平台检测

判定 shell 列表的是**服务器**的平台，不是浏览器。

- 不使用 `navigator.userAgent`
- 切到终端 Tab 时调用 `GET /api/terminals/profiles` 拉取后端可用 profile 列表
- 后端在启动时按平台探测可执行文件，探测失败的 profile 不会出现

## Profile 列表（服务器侧）

| 服务器平台 | 内置 profiles |
|------|---------------|
| Windows | PowerShell、Command Prompt、Git Bash |
| macOS | bash、zsh |
| Linux | bash、zsh |

---

## UI 结构

- 底部面板"终端"标签页激活时显示
- **左侧**：xterm.js 渲染的 PTY 输出区（当前活跃会话）
- **右侧**：仿 VS Code 的会话侧边栏（约 180 px），列出本面板内所有活跃会话
  - 顶部 action 区：`+` 按 **当前 profile** 新建终端；`∨` 弹出 profile 菜单后按所选 profile 新建
  - 列表区：每行 = 一个会话；hover / 激活显示 `×` 关闭按钮
- 关闭按钮：复用底部面板自身的关闭按钮

会话切换：只切换可见性，不销毁后端 PTY；切回时 xterm 保留滚动缓冲，原 PTY 仍在跑。

---

## 多会话约束

- 所有会话**全程挂载**，只是非活跃的会话用 `visibility: hidden` 隐藏；这样切换时不会丢失 xterm 状态
- **底部面板折叠时**（拖动到阈值以下 / 标题栏的折叠按钮）也只是隐藏，BottomPanel 保持挂载、终端会话不掉线；恢复时所有会话和滚动缓冲都在
- 终端会话仅在以下三种情况被销毁：
  1. 用户在会话侧边栏点 `×` 关闭某个会话
  2. 用户点 **BottomPanel 标题栏** 的 `×`（"关闭面板"）— 此操作视作硬关闭，会卸载整个 BottomPanel 并 kill 所有 PTY
  3. 工作区切换 — 所有 PTY 一起 kill（cwd 已经不再适用）
- 单服务器最多 16 个并发 PTY（后端 `MAX_TERMINAL_SESSIONS`），达到上限新会话创建返回 `429 TOO_MANY_SESSIONS`，前端弹出错误提示

---

## 工作区边界

终端 cwd 守卫由后端实现，详见 [terminal-api.md](../backend/terminal-api.md#工作区边界守卫)。前端表现：

- 当用户的 `cd ..` 试图离开 `WORKSPACES_ROOT` 时，后端发回一帧黄色警告，xterm 直接渲染
- 用户**仍停留在原 cwd**，无需手动 `cd` 回去
- 当前阶段是输入解析启发式，复杂语法（管道 / 子命令 / 多语句）可能绕过；真正的隔离将通过后续阶段的容器化执行环境兜底

---

## 键位

| 快捷键 | 行为 |
|--------|------|
| `Ctrl+Shift+C` | 复制 xterm 当前选中的文本到系统剪贴板。**前端拦截了浏览器默认的"打开开发者工具"** |
| `Ctrl+Shift+V` | 从系统剪贴板读文本，作为 `input` 帧发给 PTY（粘贴）|
| `Ctrl+C` | 透传给 PTY（中断当前命令，shell 原生行为）|
| `Ctrl+V` | 透传给 PTY，shell 自行决定如何处理 |

剪贴板访问通过 `navigator.clipboard.{readText,writeText}`，需要 secure context（HTTPS 或 localhost）。

---

## 会话生命周期

1. 用户在侧边栏点 `+` 或选 profile → 调 `POST /api/terminals` 创建后端会话
2. 拿到 `id` 与 `wsUrl` 后建立 WebSocket
3. xterm.js 监听用户输入，发 `{ type: 'input', data }`
4. xterm 容器 ResizeObserver 触发 fit() 后立刻发 `{ type: 'resize', cols, rows }`
5. 服务器 `output` 帧到达直接 `term.write(data)`
6. 收到 `exit` 帧 → 渲染退出提示 → 行内 `关闭` 按钮可清掉这条会话
7. 仅在 **关闭会话 / 关闭面板 / 切换工作区** 时主动断开 WS，触发 `DELETE /api/terminals/:id`（同时关闭 WS 即足够，后端兜底 kill）。折叠 / 隐藏面板**不**断开。

---

## 当前阶段实现范围

- xterm.js + WebSocket 真实执行
- **多会话并行**（一个面板内任意数量，受后端配额限制）
- **跨折叠 / 隐藏持久化**：底部面板折叠或拖到阈值以下，终端不掉线
- 复制 / 粘贴：`Ctrl+Shift+C` / `Ctrl+Shift+V`，避开浏览器开发者工具快捷键
- 不持久化会话——刷新页面会丢

---

## 后续扩展方向

- 拆分布局（左右 / 上下，多会话并排展示）
- 重命名会话标题
- 自定义 profile（用户写入 `.osheep/settings.json`）
- 终端字号 / 颜色随主题
- 历史命令、复制粘贴增强
- 集成任务运行器
- 录像 / 回放
