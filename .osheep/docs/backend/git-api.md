# Git API

## 目标

为前端"源代码管理"面板与未来的 AI 工具调用提供工作区 Git 仓库的状态读取、暂存、提交、撤销等能力。

后端实现统一通过 `git` CLI 子进程完成（不嵌入 libgit2），与系统 Git 行为一致。

---

## 适用范围

- 工作区根需要是一个 Git 仓库（`<workspaceRoot>/.git` 存在）
- 任何写操作前，先做仓库存在性校验，否则返回 `409 NOT_A_REPO`
- `init` 接口是例外，用于把当前工作区初始化为仓库

---

## 端点

挂在 `/api/workspaces/:id/git` 下。

### `GET /repo`

返回仓库基本信息。

响应：
```json
{
  "isRepo": true,
  "branch": "main",
  "head": "6d96054...",
  "ahead": 0,
  "behind": 0,
  "upstream": "origin/main",
  "detached": false
}
```

- 不是 Git 仓库时：`{ "isRepo": false }`（HTTP 200）

---

### `GET /status`

返回工作区与暂存区的变更列表。

实现：`git status --porcelain=v1 -z --untracked-files=all`

响应：
```json
{
  "isRepo": true,
  "branch": "main",
  "head": "6d96054...",
  "ahead": 0,
  "behind": 0,
  "changes": [
    {
      "path": "src/main.ts",
      "indexStatus": "M",
      "worktreeStatus": " ",
      "renamedFrom": null
    },
    {
      "path": "notes.md",
      "indexStatus": "?",
      "worktreeStatus": "?",
      "renamedFrom": null
    }
  ]
}
```

- `indexStatus` / `worktreeStatus` 直接来自 porcelain v1 的两字符状态码
  - `?` 未跟踪
  - `M` 修改
  - `A` 新增
  - `D` 删除
  - `R` 重命名
  - `C` 冲突两边都有更新
  - ` ` 空（未变）
- 前端在分组时按规则：
  - 任一为非空且 `indexStatus` 非空非空格 → 暂存的更改
  - `worktreeStatus` 非空非空格或都是 `?` → 工作区更改
  - 同一文件可同时出现在两组（如部分 stage）

---

### `POST /stage`

请求 body：
```json
{ "paths": ["src/main.ts", "notes.md"] }
```

实现：`git add -- <paths>`

响应：`{ ok: true }`

---

### `POST /unstage`

请求 body：
```json
{ "paths": ["src/main.ts"] }
```

实现：`git reset HEAD -- <paths>`（兼容首次 commit 前的特殊情况）

响应：`{ ok: true }`

---

### `POST /discard`

请求 body：
```json
{ "paths": ["src/main.ts"] }
```

实现：
- 已跟踪文件：`git checkout -- <path>`
- 未跟踪文件（status 为 `??`）：物理删除文件 `fs.unlink` / `fs.rm`

注意：**不可逆**，前端必须做二次确认。

响应：`{ ok: true, discarded: ["src/main.ts"] }`

---

### `POST /commit`

请求 body：
```json
{ "message": "fix: handle nullable user" }
```

实现：`git commit -m "<message>"`

- 不允许空消息
- 不强制要求暂存非空（让 git 自己报错并透传）
- 不带 `--no-verify`，让钩子正常生效

响应：
```json
{ "ok": true, "head": "abcdef0..." }
```

---

### `POST /init`

把当前工作区初始化为 Git 仓库（`git init`）。

请求 body：`{}`

响应：`{ ok: true }`

---

### `GET /remotes`

列出已配置的远程。

实现：`git remote -v` 解析，按 name 去重并保留 fetch URL。

响应：
```json
{
  "remotes": [
    { "name": "origin", "url": "https://github.com/user/repo.git" }
  ]
}
```

---

### `POST /remotes`

添加远程。

请求 body：
```json
{ "name": "origin", "url": "https://github.com/user/repo.git" }
```

校验：
- `name` 必须匹配 `^[A-Za-z0-9._-]{1,64}$`
- `url` 非空字符串，长度 ≤ 1000
- 不允许 `name` 已存在 → `409 ENTRY_EXISTS`

实现：`git remote add <name> <url>`

响应：`{ ok: true }`

---

### `DELETE /remotes/:name`

移除远程。

实现：`git remote remove <name>`

响应：`{ ok: true }`

---

### `GET /log?limit=&offset=&ref=`

返回提交历史，供前端图形视图渲染。

请求 Query：

| 参数 | 默认 | 说明 |
|------|------|------|
| `limit` | 200 | 单次返回提交数（上限 1000） |
| `offset` | 0 | 跳过最近 N 个提交 |
| `ref` | `HEAD` | 起点 ref，例如 `--all` / `main` |

实现：`git log --pretty=format:%H%x00%P%x00%an%x00%at%x00%s -n <limit> --skip=<offset> --decorate=full <ref>`

响应：
```json
{
  "commits": [
    {
      "sha": "6d96054...",
      "shortSha": "6d96054",
      "parents": ["4a27d06...", "..."],
      "author": "psheep303",
      "date": 1731749200,
      "subject": "add other function to the frontend",
      "refs": ["refs/heads/main", "HEAD"]
    }
  ],
  "head": "6d96054..."
}
```

- 日期 `date` 是 commit time 的 Unix 秒
- `parents` 含 0..N 个父 SHA（0=root commit，2+=merge commit）
- `refs` 列出 decorate 给出的 ref，前端用来生成徽章

---

### `GET /diff?path=&base=&head=`

读取单个文件在指定两个版本之间的内容，供前端 Monaco DiffEditor 双栏渲染。

请求 Query：

| 参数 | 取值 | 说明 |
|------|------|------|
| `path` | string | 工作区相对路径 |
| `base` | `HEAD` \| `INDEX` | 左侧基线（默认 `HEAD`） |
| `head` | `INDEX` \| `WORKTREE` | 右侧版本（默认 `WORKTREE`） |

实现：
- `HEAD` → `git show HEAD:<path>`
- `INDEX` → `git show :<path>`
- `WORKTREE` → 直接读磁盘文件

响应：
```json
{
  "path": "src/main.ts",
  "base": "HEAD",
  "head": "WORKTREE",
  "leftContent": "...",
  "rightContent": "...",
  "leftMissing": false,
  "rightMissing": false
}
```

- 文件在某一侧不存在（新增 / 删除场景）→ 对应 `*Missing` 为 true，对应 `*Content` 为空字符串
- 文件被识别为二进制时，`leftContent` / `rightContent` 都为空，响应额外字段 `binary: true`

---

## 错误码

| HTTP | code | 含义 |
|------|------|------|
| 409 | `NOT_A_REPO` | 当前工作区不是 Git 仓库 |
| 400 | `EMPTY_COMMIT_MESSAGE` | commit 消息为空 |
| 400 | `INVALID_PATH` | 路径非法 |
| 400 | `INVALID_REF` | base / head 取值不合法 |
| 500 | `GIT_FAILED` | git CLI 退出码非 0；错误体附带 stderr 截断 |

---

## 安全约束

- 所有 path 经过与 [file-api.md](file-api.md) 相同的路径校验，禁止越界
- commit message 通过 `argv` 传递，**不**走 shell 拼接
- 不暴露任意 `git` 子命令执行接口；前端 / AI 想做高级操作请通过终端

---

## 设计原则

1. **与系统 Git 一致**：所有副作用与本地 `git status / add / commit` 完全一致
2. **写操作粒度小**：每个 endpoint 单一职责，方便审计与撤销
3. **足够 AI 调用**：参数与响应都是基本类型，无 stream
4. **diff 接口为查看而设**：不在后端拼接 patch，让前端用 DiffEditor 渲染
