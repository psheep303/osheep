# 后端接口架构

## 目标

osheep 的**所有**文件与终端操作都在服务器侧执行，前端只持有 URL/路径字符串并通过 HTTP / WebSocket 调用后端。这样部署到远程服务器后，用户在浏览器里改的就是服务器上的文件。

---

## 关键架构决策

1. **不使用浏览器 File System Access API**
   - 前端不直接读取用户本地磁盘
   - 所有文件操作走后端 REST 接口
   - 终端会话由后端的 `node-pty` 实例承载，前端用 xterm.js + WebSocket 透传

2. **工作区 (workspace) 是后端的一等概念**
   - 后端启动时通过 `WORKSPACES_ROOT` 环境变量指定一个父目录
   - 该父目录下每个一级子目录视为一个 workspace
   - 每个 workspace 拥有自己的 `.osheep/`
   - 前端通过工作区 API 列出 / 选择当前工作区，后续所有调用必须带 `workspaceId`

3. **AI 也调用同一组接口**
   - 文件 API 与终端 API 的 schema 设计为可被 LLM 工具调用直接消费
   - 后端不为 AI 单独搭一套接口；前端用什么，AI 用什么

---

## 服务职责

### API 服务（osheep-backend）
负责：
- 工作区发现与路径解析（含安全检查）
- 文件读写、目录管理（详见 [file-api.md](file-api.md)）
- 全工作区文本搜索（详见 [search-api.md](search-api.md)）
- Git 状态读取与日常提交流（详见 [git-api.md](git-api.md)）
- 终端会话管理与 PTY 透传（详见 [terminal-api.md](terminal-api.md)）
- `.osheep/` 相关操作（settings、plan、docs）
- AI 流程接口、任务接口（后续阶段补全）

### Worker 服务（后续阶段）
负责：
- 执行 AI 文档生成
- 执行 Todo 生成
- 执行长耗时开发任务
- 写回结果与状态

---

## 接口分组

### 工作区接口
- `GET /api/workspaces` 列出所有工作区
- `GET /api/workspaces/:id` 单个工作区元信息
- 后续：创建 / 删除 / 重命名工作区

### 文件接口
- 详见 [file-api.md](file-api.md)
- 都挂在 `/api/workspaces/:id/fs` 下
- 路径都是相对于工作区根的 POSIX 风格相对路径

### 搜索接口
- 详见 [search-api.md](search-api.md)
- 都挂在 `/api/workspaces/:id/search` 下
- 单次请求扫描完成，前端搜索面板与 AI 工具调用共用

### Git 接口
- 详见 [git-api.md](git-api.md)
- 都挂在 `/api/workspaces/:id/git` 下
- 通过 `git` CLI 子进程实现；不嵌入 libgit2

### 终端接口
- 详见 [terminal-api.md](terminal-api.md)
- REST 控制 + WebSocket 流

### 设置接口
- `GET /api/workspaces/:id/settings`
- `PUT /api/workspaces/:id/settings`
- 直接读写 `.osheep/settings.json`，缺失字段使用默认值

### AI 流程接口（后续）
- 提交需求 / 生成文档 / 修订文档 / 生成 Todo / 启动执行

### 任务接口（后续）
- 查询任务列表 / 详情 / 日志流 / 中断 / 重试

---

## 通信方式

- 普通请求：HTTP + JSON
- 大文件读写：当前阶段统一按 UTF-8 文本处理；二进制文件后续单独走流式接口
- 终端 IO、任务日志：WebSocket
- 长耗时流程：异步任务 + 状态轮询 / 推送

---

## 错误约定

- HTTP 状态码用于传输层：`400` 参数错误、`403` 越界访问、`404` 找不到、`409` 冲突、`500` 内部错误
- 业务错误响应体统一为 `{ error: { code, message } }`
- `code` 用 SCREAMING_SNAKE_CASE，例如 `PATH_OUTSIDE_WORKSPACE`、`ENTRY_EXISTS`、`NOT_A_DIRECTORY`

---

## 安全基线

1. **路径越界防护**
   - 所有传入的 `path` 必须是相对路径，不允许以 `/` 或盘符开头
   - 不允许包含 `..` 段
   - 解析后必须落在对应 workspace 根之内
   - 任何违例直接 `403 PATH_OUTSIDE_WORKSPACE`

2. **终端越界防护**
   - PTY 进程的 `cwd` 必须落在 workspace 内
   - 关闭连接后必须 kill PTY，避免孤儿进程

3. **认证（后续阶段）**
   - 当前阶段不带 auth，仅供本机 / 内网使用
   - 后续接入 session / token，再分接口粒度的权限

---

## 与前端的关系

- 前端不再持有 `FileSystemDirectoryHandle`
- 前端 `fs` 模块改名为 `api/fs.ts`，对外签名形如 `readDir(workspaceId, path)`，参数都是字符串
- 前端 `Terminal` 通过 WebSocket 直连后端 PTY 会话
