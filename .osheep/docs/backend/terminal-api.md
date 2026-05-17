# 终端 API

## 目标

为前端 / AI 提供"在某个工作区里运行 shell"的能力。后端用 `node-pty` 启一个 PTY 进程，前端用 xterm.js 渲染输出并把按键透传过去。

---

## 协议总览

- **会话生命周期**：通过 REST 创建 / 销毁
- **IO 流**：每个会话有一条 WebSocket
- **复用**：同一个 workspace 可以有多个并行会话（多个终端 Tab）
- **AI 用法**：AI 也走同一组接口，只是它的输入通常是命令字符串 + 期望的退出判定

---

## 路径

- `POST /api/terminals` — 创建会话
- `GET /api/terminals` — 列出当前进程内所有活跃会话
- `DELETE /api/terminals/:id` — 销毁会话（kill PTY）
- `WS /api/terminals/:id/io` — 双向 IO 流

---

## 端点

### `POST /api/terminals`

请求 body：
```json
{
  "workspaceId": "demo",
  "shell": "powershell",
  "cols": 100,
  "rows": 30
}
```

- `workspaceId`：必填，会话 cwd 锁在该工作区根目录
- `shell`：`powershell` / `cmd` / `bash` / `zsh`
  - 若服务器是 Windows，可用值为 `powershell` / `cmd` / `bash`
  - 若服务器是 Linux / macOS，可用值为 `bash` / `zsh`
  - 不支持的 shell 返回 `400 UNSUPPORTED_SHELL`
- `cols` / `rows`：初始尺寸，可选，默认 80×24

响应：
```json
{
  "id": "t_5f3c2e",
  "shell": "powershell",
  "cols": 100,
  "rows": 30,
  "wsUrl": "/api/terminals/t_5f3c2e/io"
}
```

---

### `GET /api/terminals`

响应：
```json
{
  "sessions": [
    {
      "id": "t_5f3c2e",
      "workspaceId": "demo",
      "shell": "powershell",
      "cols": 100,
      "rows": 30,
      "createdAt": 1735689600000
    }
  ]
}
```

---

### `DELETE /api/terminals/:id`

立即 kill PTY 进程并关闭对应 WS。响应 `{ "id": "t_5f3c2e" }`。

---

### `WS /api/terminals/:id/io`

升级为 WebSocket 后，前后端互发**文本帧**，帧内是 JSON：

#### 客户端 → 服务端
```json
{ "type": "input", "data": "ls\r" }
{ "type": "resize", "cols": 120, "rows": 40 }
{ "type": "ping" }
```

#### 服务端 → 客户端
```json
{ "type": "output", "data": "..." }
{ "type": "exit", "code": 0, "signal": null }
{ "type": "error", "message": "..." }
{ "type": "pong" }
```

- `output.data` 是 PTY 的原始字节流（UTF-8 串），包含 ANSI 控制序列，xterm.js 直接 `term.write`
- `exit` 之后服务器主动关闭 WS

---

## Shell 选择策略

服务器会暴露一个 `GET /api/terminals/profiles` 返回当前可用的 shell 列表：

```json
{
  "os": "windows",
  "profiles": [
    { "id": "powershell", "label": "PowerShell", "executable": "powershell.exe" },
    { "id": "cmd", "label": "Command Prompt", "executable": "cmd.exe" },
    { "id": "bash", "label": "Git Bash", "executable": "C:\\Program Files\\Git\\bin\\bash.exe" }
  ]
}
```

前端不再用 `navigator.userAgent` 判定平台，而是直接调这个接口——因为现在重要的是**服务器**的平台，不是浏览器的平台。

`executable` 路径在服务器启动时探测（PowerShell / cmd 用 PATH，Git Bash 在 Windows 用注册表 / 默认安装路径，bash / zsh 用 `which`）。探测失败的 profile 不会出现在列表里。

---

## 错误码

| code | 含义 |
|------|------|
| `WORKSPACE_NOT_FOUND` | 指定 workspace 不存在 |
| `UNSUPPORTED_SHELL` | shell 未在当前服务器探测到 |
| `SESSION_NOT_FOUND` | id 对应的会话已不存在 |
| `INVALID_SIZE` | cols / rows 越界（< 1 或 > 1000） |
| `PTY_SPAWN_FAILED` | node-pty 启动失败 |

---

## 服务端实现要点

1. **进程隔离**
   - 每个会话独立 `node-pty` 进程
   - 初始 `cwd` 强制为 workspace 根
   - 退出 / WS 断开时立即 kill，避免孤儿
2. **工作区目录边界**（详见下方"工作区边界守卫"）
   - 后端解析用户输入中的 `cd` 类命令
   - 离开 `WORKSPACES_ROOT` 的尝试会被拒绝并下发警告帧
3. **流控**
   - PTY → WS 直接转发，但 WS backpressure 触发时暂停 PTY `pause()`，恢复时 `resume()`
4. **超时**
   - 会话无活动 30 分钟自动 kill（可配置）
5. **资源上限**
   - 单服务器最多 N 个并发会话（默认 16），超出返回 `429 TOO_MANY_SESSIONS`
6. **Heartbeat**
   - WS 上每 15 秒一次 ping / pong 探测，断线立即 kill PTY

---

## 工作区边界守卫

终端是真实 shell，理论上可以 `cd` 到服务器任意位置。osheep 在两个层面做加固：**PTY 的逻辑 cwd 必须落在 `WORKSPACES_ROOT` 之内**（注意是 root 父目录本身，不是单个工作区；用户可以在多个工作区之间 `cd ../<other>`）。

### 第一层：Shell-Level 代理（强）

每个新 PTY 启动时，后端为对应 shell 写入一个一次性 init 脚本，shell 启动时自动加载它。脚本里：

1. 把目标根目录写进环境变量 `OSHEEP_WORKSPACE_ROOT`
2. 用语言原生机制覆盖目录切换命令：
   - PowerShell：定义 `function global:Set-Location { ... }`，并把 `cd / chdir / sl` 重新 alias 到这个函数。函数内部用 `[IO.Path]::GetFullPath` 解析目标，若落在根外则打印黄字警告并直接返回。脚本 **以 UTF-8 BOM 写入磁盘**（Windows PowerShell 5.1 默认会用 ANSI/系统区域代码页读取无 BOM 的脚本，BOM 让它确定按 UTF-8 解析，从而避免警告里"拒绝"等中文被读成 GBK 字节再向终端输出造成的 UTF-8 ↔ GBK 双向乱码）；脚本顶部还强制 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 让 Write-Host 的字节也按 UTF-8 输出到 xterm.js
   - bash / Git Bash：定义 `cd () { ... }`，用 `realpath -m` 解析目标后做前缀比较，越界则 stderr 警告并 `return 1`
   - cmd.exe：写两个一次性 `.cmd` 文件（init + helper），**均不带 BOM**——cmd 的批处理解析器不会跳过 UTF-8 BOM，BOM 字节会被当作首行命令的一部分导致 `@echo off` 失败并把后续每行都回显，所以一定要无 BOM。Init 用 `chcp 65001 > nul` 切码页、`set OSHEEP_WORKSPACE_ROOT=...`、再用 `doskey cd=call "helper.cmd" $*`（含 `chdir`）把交互输入的 `cd / chdir` 转发到 helper。helper 用 `pushd` 把目标 canonicalize 成绝对路径，再用 `findstr /i /b /c:"<root>\\"` 做大小写不敏感前缀比较（`\\` 的双反斜杠是为了让 findstr 的 CRT argv 解析器收到一个尾随 `\`）；越界则中文警告并 `exit /b 1`，否则真正执行 `cd /d`。cmd 进程用 `cmd /D /K initpath` 启动，`/D` 跳过用户 `AutoRun` 注册项，避免诸如 `chcp 65001 / Active code page: 65001` 这种 AutoRun 输出污染首屏。会话退出时 init + helper 两个临时文件随 `guardCleanup` 一起删除
3. 把 PTY 启动后的当前目录设到 workspace 根

这层覆盖了 `cd ..` 与历史回放（↑ 键）、粘贴等会跳过输入缓冲的所有情形。

### 第二层：Input-Buffer 启发式（弱）

仍保留第一轮的输入字符缓冲解析（详见 `pty.ts` 中 `parseCdTarget`），作为兜底：

1. 服务端为每个会话维护 `logicalCwd` 与 `inputBuffer`
2. 用户输入按字符转发到 PTY 的同时镜像到 `inputBuffer`
3. Enter 时解析 `cd / chdir / Set-Location / sl / pushd`；越界则发 `\x03` + 黄字警告，并**不**转发 Enter
4. 遇到任意控制字符 / Tab，标记 `bufferDirty=true`，该行不做检查（避免误判）——此时全靠第一层

### 限制

- 这是**前置启发式**，不是完整的越界沙箱
- 用户仍可通过 `cat /etc/passwd` 类命令读取 workspace 之外的文件——文件 API 的越界守卫负责挡住前端的文件访问，但 shell 内部命令不归终端 API 管
- 进阶绕过（直接调 `[System.IO.Directory]::SetCurrentDirectory`、`builtin cd` 等）仍可能绕过第一层
- 真正的越界沙箱需要容器化执行环境（后续阶段：把每个 workspace PTY 放进 Docker）

### 客户端表现

```
demo>cd ..
workspaces>cd ..
[osheep] 拒绝: 目标 'D:\project\osheep\backend' 超出 workspaces 根
workspaces>
```

- 黄色警告由 shell 内部输出，或在 buffer 启发式触发时由后端写入 WS
- Ctrl-C 取消当前行的副作用是 PTY 会回显 `^C` 与新提示符

---

## 设计原则

1. **后端是 PTY 的唯一持有者**——前端只是显示窗
2. **协议尽量哑**——前端不解析 ANSI，直接交给 xterm.js
3. **AI 用得起**——AI 想跑命令的话，只要拿 wsUrl 然后发 `input` 帧、收 `output` 帧即可，足以做半交互工具调用
4. **能 kill 就立刻 kill**——任何异常路径都不留孤儿进程

---

## 后续扩展方向

- 命令录像 / 回放
- AI 专用一次性命令接口（`POST /api/terminals/exec`，跑完返回 stdout / exit）
- 多窗格 / 拆分
- 自定义 profile（用户写入 `.osheep/settings.json`）
