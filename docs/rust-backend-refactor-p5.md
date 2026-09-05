# Rust 后端重构 P5 实施记录

P5 第一批迁移工作区全文搜索，第二批迁移 Git 仓库探测、状态和文件内容 diff，第三批完成
Git 只读元数据与历史查询，第四批完成 Git 网络命令和有界任务队列基础设施。以下接口现在由
Rust 直接执行，前端 API 和返回 JSON 契约不变：

- `GET /api/workspaces/:id/search`
- `GET /api/workspaces/:id/git/repo`
- `GET /api/workspaces/:id/git/status`
- `GET /api/workspaces/:id/git/diff`
- `GET /api/workspaces/:id/git/remotes`
- `GET /api/workspaces/:id/git/branches`
- `GET /api/workspaces/:id/git/log`
- `GET /api/workspaces/:id/git/commits/:sha`
- `GET /api/workspaces/:id/git/commits/:sha/diff`
- `POST /api/workspaces/:id/git/init`
- `POST /api/workspaces/:id/git/stage`
- `POST /api/workspaces/:id/git/unstage`
- `POST /api/workspaces/:id/git/discard`
- `POST /api/workspaces/:id/git/commit`
- `POST/DELETE /api/workspaces/:id/git/remotes[/:name]`
- `POST /api/workspaces/:id/git/checkout`
- `POST /api/workspaces/:id/git/fetch`
- `POST /api/workspaces/:id/git/pull`
- `POST /api/workspaces/:id/git/push`

`osheep-core::WorkspaceChangeTracker` 现在提供工作区变更指纹索引。Git 工作区读取
`GitService::status` 生成 Node 兼容的 `indexStatus|worktreeStatus|renamedFrom|size|mtime`
指纹；非 Git 工作区首次扫描最多 50000 个文件，并在后续刷新时消费 `FileService` 的变更
journal，只重扫受影响文件或目录子树。journal 溢出、watcher overflow 或根目录事件会触发
一次保守的完整重扫。初始和增量扫描都通过有界 `BackgroundTaskQueue` 的后台优先级执行。

## 搜索契约

`osheep-core::SearchService` 保留 Node 搜索的主要边界：

- 默认最多扫描 5000 个文本文件，HTTP 参数上限为 50000。
- 单文件最大 2 MiB，读取前进行 metadata 检查，并以头 8 KiB 进行二进制嗅探。
- 每文件默认最多返回 100 个命中，HTTP 参数上限为 1000；达到文件或命中上限时返回
  `truncated: true`。
- 默认跳过 `node_modules`、`.git`、`dist`、`build`、`.next`、`.vite` 和 `.cache`。
- 支持大小写、全词、正则、include/exclude glob；结果按 POSIX 相对路径返回并排序。
- `line`/`column`、`matchStart` 和 `matchEnd` 使用前端兼容的 UTF-16 单位，因此中文或 emoji
  之前的命中仍能正确定位和高亮。
- 空 query 和非法正则继续返回 HTTP 400 `INVALID_QUERY`。布尔参数接受 Node 的 `true|1`，
  数值上限保留 `Number.parseInt` 的前缀解析、默认值和有限数判断。

Rust 使用线性时间的 `regex` crate。常用表达式行为保持一致，但 JavaScript 特有的反向引用和
look-around 当前会返回 `INVALID_QUERY`，而 Node 曾接受其中一部分；该兼容差异需在 P5 后续批次
决定是显式收窄契约还是引入受预算约束的兼容引擎。

## 并发与取消

搜索使用独立 semaphore，默认最多并行两个任务，不占用交互式文件读取或目录枚举的 permit。
遍历和文本匹配在 blocking worker 中执行，避免阻塞 Tokio HTTP executor。permit 由 worker 持有，
HTTP future 被取消时设置原子取消标记；worker 在每个目录项、文本行和匹配之间检查标记，退出后
才释放 permit，因此中止请求不会脱离并发上限继续无界扫描。

搜索接口仍保持有预算的即时匹配；变更 tracker 独立维护文件指纹，不改变现有搜索结果契约。

## 有界任务队列

`osheep-core::BackgroundTaskQueue` 提供共享服务内的有界异步任务执行基础：任务总数（排队和
运行中）受 `max_pending` 限制，工作线程数由调用方设置。交互任务始终从后台任务前取出；后台
任务可暂停并在恢复后继续排队。每个任务收到协作式 `TaskCancellation`，取消排队任务会立即释放
容量，运行中任务在其下一次检查令牌后进入 `Cancelled`。任务完成和失败分别记录为
`Completed`/`Failed`，供后续索引构建和运行报告复用。

队列不强制终止忽略取消令牌的用户 future；索引任务必须在目录项、文件读取和匹配循环中主动
检查令牌。这样可保持交互式 `fs/file` 的独立读取配额，并确保取消后资源最终由任务自身释放。

## Git 只读基础契约

`osheep-core::GitService` 保留现有 Node 接口的主要行为：

- `.git` 可以是目录或 worktree 使用的文件；非仓库的 repo/status 查询返回 `isRepo: false`，
  diff 返回 HTTP 409 `NOT_A_REPO`。
- repo 查询返回 HEAD、分支、detached、upstream 和 ahead/behind；无首次提交的仓库允许空 HEAD。
- status 使用 `git status --porcelain=v1 -z --untracked-files=all --ignored=matching`，独立返回
  `changes` 与去掉末尾斜杠的 `ignoredPaths`，并保留 rename 的 `renamedFrom`。
- diff 的 `base` 仅接受 `HEAD|INDEX`，`head` 仅接受 `INDEX|WORKTREE`；非法值返回 HTTP 400
  `INVALID_REF`。响应返回左右文本、缺失状态和二进制标记，不在后端生成补丁。
- 文件参数统一成 POSIX 相对路径并拒绝绝对路径、NUL 和 `..`；WORKTREE 读取会解析真实路径并
  阻止符号链接越出工作区。
- remotes 优先返回 fetch URL 并按名称排序；branches 区分 local/remote，保留 current、detached、
  upstream 和可用的 ahead/behind 信息。
- log 默认 200 条、上限 100000 条，`limit/offset` 保留 Node `Number.parseInt` 的前缀解析规则；
  非仓库返回空历史，空仓库或不存在的 revision 返回带 null refs 的空结果。
- commit details 返回作者、完整消息、numstat、状态和二进制标记；commit diff 读取首父提交与当前
  提交中的文件内容，根提交将左侧标记为 missing。
- commit SHA 限制为 7 到 64 位十六进制并以 `INVALID_REF` 拒绝非法输入。log 接受普通 revision
  和显式 `--all`；其他以 `-` 开头的输入也返回 `INVALID_REF`，不能覆盖固定输出或分页参数。
- 本地写操作使用固定参数数组：`init` 可用于空工作区；stage/unstage/discard 只接受字符串路径
  数组；commit 拒绝空消息并返回新 HEAD；remote 名称和 branch/fromRef 均经过字符集与长度校验。
  discard 对 tracked 文件使用 checkout，对 untracked 文件安全删除并返回 POSIX 相对路径列表。
- 写操作错误保持 Node 分类：空 commit 为 `EMPTY_COMMIT_MESSAGE`，脏工作区为 `DIRTY_WORKTREE`，
  重复 remote 为 `ENTRY_EXISTS`，非法分支/ref 为 `INVALID_REF`，普通 Git 失败为 `GIT_FAILED`。
- fetch/pull/push 使用独立的网络超时预算（默认 120 秒），仍复用 Git semaphore、取消、终止和
  输出上限。fetch 支持 `--prune` 与显式 `--all`；pull 默认 `--ff-only`；push 支持
  `--force-with-lease` 和显式 `-u remote branch`。网络失败沿用 Git 错误分类，并禁止通过
  remote/branch 字段注入额外选项。

Git 命令通过固定参数数组启动，不经过 shell，并设置 `GIT_TERMINAL_PROMPT=0` 和空 stdin。
服务使用独立的两路 semaphore，不占用文件读取、目录枚举或搜索 permit。每条命令默认 15 秒
超时，stdout/stderr 共用 8 MiB 输出预算；对应错误为 `GIT_TIMEOUT` 和
`GIT_OUTPUT_TOO_LARGE`，普通非零退出为 `GIT_FAILED`。

HTTP future 被取消时，drop guard 会通知后台清理任务杀掉子进程。后台任务持有 permit，直到
子进程确认退出才释放，因此断开的请求不会留下脱离并发限制的 Git 命令。超时和输出超限也走
同一终止与回收路径。

## 已覆盖测试

- Node 参考实现与 Rust 使用同一 fixture 验证 glob、忽略目录、二进制跳过、全词匹配和 UTF-16
  列号。
- HTTP 契约验证 include/exclude、`wholeWord=1`、宽松整数解析、截断结果和非法正则错误码。
- 核心测试验证每文件命中上限、400 字符预览及前后省略位置。
- 取消测试中止一个扫描 2 MiB 文本的任务，并验证唯一搜索 permit 在 worker 退出后归还。
- Git 核心测试覆盖 porcelain rename/ignored 解析、HEAD/INDEX/WORKTREE 内容、remotes、branches、
  log、详情统计、根提交/普通提交 diff、输出上限、取消、超时和子进程退出后的 permit 归还。
- Git HTTP 契约测试覆盖全部只读路由、宽松分页、默认 ref、非仓库、非法 SHA/option-like ref 和
  越界路径错误码。
- Git 写入 HTTP 契约测试覆盖 init、stage/unstage、tracked/untracked discard、commit、remote 增删、
  checkout、非仓库和错误请求体的稳定错误码。
- Git 网络核心测试使用本地 bare repository 验证 push/upstream、fetch、ff-only pull、`--all`/远端
  校验和 `setUpstream` 缺参；HTTP 契约测试覆盖 push、fetch、pull 的成功路径及参数/非仓库错误码。
  真实 HTTPS 凭据、代理和远端服务矩阵留待平台验证。
- 任务队列核心测试覆盖交互优先级、后台暂停/恢复、有界容量、协作式取消和失败状态记录。
- 变更 tracker 核心测试覆盖指纹新增/修改/删除比较、非 Git 工作区增量写入、目录移动的旧/新子树
  刷新，以及 journal 溢出触发完整重扫。

## P5 后续工作

- 解决 JavaScript 高级正则兼容策略，并增加大型工作区搜索性能与内存基准。
