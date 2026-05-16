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

终端是真实 shell，理论上可以 `cd` 到服务器任意位置。osheep 强制约束：**PTY 的逻辑 cwd 必须落在 `WORKSPACES_ROOT` 之内**（注意是 root 父目录本身，不是单个工作区；用户可以在多个工作区之间 `cd ../<other>`）。

### 算法

1. 服务端为每个会话维护 `logicalCwd`（初始 = workspace 根）以及一个 `inputBuffer`
2. 用户输入按字符转发到 PTY 的同时，被镜像到 `inputBuffer`
3. 当遇到 `\r` / `\n`（Enter）时：
   - 解析 `inputBuffer` 是否匹配 `cd <target>` / `chdir` / `Set-Location` / `sl` / `pushd`（不区分大小写，支持 `cd /d ...` 的 cmd 语法）
   - 解析 target 为绝对路径 `path.resolve(logicalCwd, target)`
   - 若结果仍在 `WORKSPACES_ROOT` 内：更新 `logicalCwd`，正常转发 Enter
   - 若越界：**不转发 Enter**，改为发送 `\x03`（Ctrl-C）给 PTY 取消当前行，并通过 WS 下发一帧 `{ type: 'output', data: '\r\n\x1b[33m警告：超出 workspaces ...\x1b[0m\r\n' }`
4. 出现任意控制字符（ESC / Tab / Ctrl-*）会把 `bufferDirty=true`；该行不再做边界检查（避免误判），允许通过
5. 仅做行内 `cd`，不解析复合语句（`cd ..; ls`、`if ... { cd .. }`、`pushd` 后的 `popd` 栈、`$(...)` 子命令）

### 限制

- 这是**前置启发式**，不是完整的越界沙箱
- 用户仍可通过 `cat /etc/passwd` 类命令读取 workspace 之外的文件——文件 API 的越界守卫负责挡住前端的文件访问，但 shell 内部命令不归终端 API 管
- 真正的越界沙箱需要容器化执行环境（后续阶段：把每个 workspace PTY 放进 Docker）

### 客户端表现

```
demo>cd ..
workspaces>cd ..
警告：超出 workspaces，已忽略 ".."
workspaces>
```

- 黄色 ANSI 警告由后端直接写入 WS，xterm 原样渲染
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
