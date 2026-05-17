# 源代码管理面板

## 目标

在左侧栏提供一个接近 VS Code 的源代码管理（Source Control）视图：展示工作区 Git 仓库当前的变更状态，允许用户暂存 / 取消暂存 / 提交 / 撤销变更，并以 diff 形式查看具体修改。

本面板不替代终端中的高级 Git 操作（rebase、cherry-pick、复杂分支管理），定位是日常提交流。

---

## 适用范围

- 工作区根需是一个 Git 仓库（`.git/` 存在）
- 如果不是 Git 仓库：
  - 面板显示一条提示 `当前工作区不是 Git 仓库`
  - 提供 `初始化仓库` 按钮，调用后端 `POST /api/workspaces/:id/git/init`
  - 后端不为非 Git 工作区强制启用 Git 集成

---

## 入口

- 活动栏的"源代码管理"图标（已存在）
- 与"资源管理器"、"搜索"互斥

---

## 布局

```
┌───────────────────────────────────────┐
│ 头部：分支名 · 同步状态 · 刷新           │
├───────────────────────────────────────┤
│ ┌─────────────────────────────────┐    │
│ │ Commit message (textarea)        │    │
│ └─────────────────────────────────┘    │
│ [√ 提交]                                │
├───────────────────────────────────────┤
│ ▼ 暂存的更改 (n)                        │
│    M  src/index.ts        [−] [↺]       │
│    A  README.md           [−]           │
│ ▼ 更改 (n)                              │
│    M  src/main.ts         [+] [↺]       │
│    U  notes.md            [+]           │
│ ▼ 远程 (n)                              │
│    origin  https://...    [×]           │
│    [ + 添加远程 ]                       │
│ ▼ 图形                                  │
│    ● fix: …      [main]                 │
│    │                                    │
│    ● feat: …                            │
│    │                                    │
│    ● init commit                        │
└───────────────────────────────────────┘
```

### 头部

- 当前分支名（点击后续可弹出切换面板，本阶段只显示）
- 同步状态：`↑n ↓m` 表示落后 / 领先远程的提交数
- 右上角 `⟳ 刷新` 按钮，强制重新拉取状态

### 提交区

- `textarea` 多行输入框，支持回车换行
- `Commit` 按钮：disable 条件 = 暂存区为空或消息为空
- 提交成功后清空消息框，自动刷新

### 文件分组

- `暂存的更改 (Staged Changes)`：`git diff --cached` 的对象
- `更改 (Changes)`：工作区的未暂存变更
- 每一行：
  - 左侧 1 字宽状态标识（颜色 + 字母）：
    - `M` 修改（黄色）
    - `A` 新增（绿色）
    - `D` 删除（红色）
    - `R` 重命名（蓝色）
    - `U` 未跟踪（绿色，与新增同色）
    - `C` 冲突（红色加粗）
  - 中间：文件相对路径
  - 右侧悬停出现操作按钮：
    - `+` 暂存（在"更改"分组）
    - `−` 取消暂存（在"暂存的更改"分组）
    - `↺` 撤销变更（仅在"更改"分组；二次确认；删除新文件等价于 `rm`，修改文件等价于 `git restore`）
- 分组头右侧悬停出现：
  - `+ 全部暂存`（在"更改"分组）
  - `− 全部取消暂存`（在"暂存的更改"分组）

### 点击行为

- 单击文件行：在中央编辑区打开 **diff 视图**（详见下方"diff 视图"）
- diff 视图为只读，靠近 VS Code 的"工作区 vs 暂存区"或"暂存区 vs HEAD"切换

---

## 远程区域 (Remotes)

- 默认折叠，标题旁显示已配置的远程数量
- 展开后每行：`name`、URL（一行内、溢出省略）、悬停出现 `×` 删除按钮
- 区域底部固定一个 `+ 添加远程` 按钮，点击展开内联表单：
  - `name`：输入框（如 `origin`）
  - `url`：输入框（如 `git@github.com:user/repo.git`）
  - `添加` / `取消`
- 数据通过 `GET /api/workspaces/:id/git/remotes` 拉取；改动后刷新

> 当前阶段只覆盖远程 CRUD，**Push / Pull / Fetch 仍走终端**。后续阶段再补 UI。

---

## 图形区域 (Graph)

仿 VS Code"源代码管理图形"视图。展示当前仓库最近 N 个提交（默认 200），每行：
- 左侧 swim-lane 渲染：一个圆点表示该提交，竖向连线表示与父提交的关系；合并提交会显示分叉合流的弧线
- 中间：commit subject（首行）
- 右侧：作者 + 相对时间
- 若该 commit 是某个 ref（分支 / 远程分支）的 tip，则在 subject 后追加一个胶囊徽章；HEAD 所在的徽章高亮

### swim-lane 算法（前端）

1. 后端按 `git log --pretty=format:"%H%x00%P%x00%an%x00%at%x00%s" --decorate=full -n <limit>` 输出
2. 前端维护一个 lane 数组（每个元素是该 lane 当前期待的 commit SHA）
3. 遍历 commits（按时间倒序）：
   - 找出该 commit 所在的 lane（数组中第一个等于此 SHA 的下标）
   - 该 commit 的第一个父：替换 lane 上的 SHA
   - 其余父：分配新 lane 或合并入已存在 lane
   - 没有父：清掉该 lane
4. 渲染：每行画当前 lane 上的 SVG（横线、竖线、弧线段），dot 在该 commit 的 lane 列

数据契约见 [../backend/git-api.md](../backend/git-api.md) 中的 `GET /log`。

### 点击行为

- 点击某个 commit：当前阶段不做差异查看（避免与"更改 / 暂存"区域混淆）；未来可以打开"该 commit 引入的 diff"

---

## Diff 视图

- 在中央编辑区作为一个特殊 Tab 渲染
- 使用 Monaco `DiffEditor`（通过 `@monaco-editor/react`）
- Tab 标题格式：`<filename> (Working Tree)` 或 `<filename> (Staged)`
- 左侧：基线版本（`HEAD` 或暂存区）
- 右侧：当前版本（工作区或暂存区）
- 用户可关闭 Tab；diff Tab 不支持编辑
- 同一文件多次打开复用同一 Tab

---

## 数据流

```
GitView mount
  └─ api.getGitStatus(workspaceId) ──▶ 渲染分支信息 + 文件分组

user clicks `+`
  └─ api.gitStage(workspaceId, [path]) ──▶ refresh()

user clicks `−`
  └─ api.gitUnstage(workspaceId, [path]) ──▶ refresh()

user clicks `↺`
  └─ confirm() ──▶ api.gitDiscard(workspaceId, [path]) ──▶ refresh()

user enters message + clicks Commit
  └─ api.gitCommit(workspaceId, message) ──▶ refresh()

user clicks file row
  └─ openDiffTab({ path, base: "HEAD"|"INDEX", head: "INDEX"|"WORKTREE" })
        ├─ api.gitFileContent(workspaceId, path, base) ──▶ leftContent
        └─ api.gitFileContent(workspaceId, path, head) ──▶ rightContent
```

接口详见 [../backend/git-api.md](../backend/git-api.md)。

---

## 刷新策略

- 面板 mount 时刷新一次
- 任意写操作（stage、unstage、commit、discard、init）成功后刷新
- 提供顶部 `⟳` 按钮手动刷新
- 不做后端 watch 推送（当前阶段足够）

---

## 错误处理

- 调用失败时在头部下方显示红色 banner，可关闭
- 工作区根没有 `.git/` 时不报错，而是显示初始化引导

---

## UI 原则

1. 提交是日常高频动作 → 提交框始终在面板上半部
2. 文件状态颜色与字母双重编码，避免色盲歧义
3. 撤销变更必须二次确认（不可逆）
4. 高级 Git 操作（rebase、merge）引导用户使用终端
5. diff 视图视为查看工具，不在面板内嵌行级 stage（本阶段）

---

## 后续扩展（不在本阶段）

- 分支切换 / 创建
- Pull / Push / Fetch
- 提交历史（log）面板
- 行内 stage / hunk-level stage
- 多仓库（subworkspace）支持
