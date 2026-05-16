# 工作区管理

## 目标

osheep 把每个项目当作一个 **服务端工作区 (workspace)**。所有文件操作、终端进程都被锁在某个 workspace 根目录之内。

部署到服务器后，用户在浏览器里看到的 / 改的是 **服务器上**的文件——不是用户本地磁盘。

---

## 工作区根目录

后端启动时通过环境变量 `WORKSPACES_ROOT` 指定一个父目录：

```
WORKSPACES_ROOT/
├── demo-app/          ← workspace id = "demo-app"
│   ├── .osheep/
│   ├── src/
│   └── ...
├── another-project/   ← workspace id = "another-project"
│   └── ...
└── ...
```

每个一级子目录都是一个 workspace。`WORKSPACES_ROOT` 自身**不是** workspace。

`workspaceId` 默认取目录名，并满足：
- 仅由 `[a-zA-Z0-9._-]` 组成
- 不以 `.` 开头
- 不超过 64 字符

不符合规则的子目录被忽略（不出现在 API 响应中）。

---

## 当前阶段职责

1. 启动时扫描 `WORKSPACES_ROOT`，发现所有合法 workspace
2. 为每次 API 调用根据 `:id` 解析出对应的根路径
3. 自动创建 `.osheep/`、`.osheep/docs/`、`.osheep/plan/`、`.osheep/settings.json`（若不存在）
4. 拦截路径越界访问
5. 给终端会话提供 `cwd` 根路径

---

## 当前阶段原则

- 后端启动后 workspace 列表通过 `GET /api/workspaces` 暴露
- 前端 / AI 通过 `workspaceId` 选定一个 workspace
- `.osheep/` 为 workspace 内固定目录
- 文档、计划、设置都落在 workspace 内，跟随项目走

---

## 安全

- 任何 API 接受的 `path` 参数必须是相对路径，最终解析后必须仍落在 workspace 根之内
- 解析使用 POSIX 风格，但底层 fs 调用按运行平台拼接绝对路径
- 任何越界尝试返回 `403 PATH_OUTSIDE_WORKSPACE` 并记录日志（含原始请求 path，不含 workspace 根绝对路径）

---

## 后续扩展方向

- 工作区创建 / 删除 API（当前阶段需要管理员手动放在 `WORKSPACES_ROOT` 里）
- Docker 隔离工作区（每个 workspace 一个容器，PTY 在容器内）
- 多任务独立执行上下文
- 快照与回滚
- 软配额与流量限制
