# Rust 后端重构 P4 实施记录

P4 第一批把工作区创建、文件读写、浅层目录列表、工作区设置和外部文件校验迁移到 Rust。
这些 API 由 `osheep-server` 直接提供，不代理 Node；路径、缓存和并发边界集中在
`osheep-core::FileService`。

P4 实现范围已完成。Linux CI、真实同步盘/网络盘和 Linux release 性能结果作为延期验证项保留，
不阻塞 P5 的实现工作，但在最终发布验收前仍必须完成。

## 工作区核心

- `POST /api/workspaces` 校验现有工作区 ID 规则并串行创建目录。
- 新工作区原子地建立 `.osheep/docs` 和默认 `.osheep/settings.json`；失败时清理未完成目录。
- `GET /api/workspaces/:id` 打开工作区时确保布局存在并记录最近项目。
- 外部工作区根必须是已存在的绝对目录，持久化逻辑继续由 P3 的 `StateStore` 负责。

## 文件 API

Rust 已直接实现：

- `GET /api/workspaces/:id/fs/tree`
- `GET/PUT /api/workspaces/:id/fs/file`
- `POST/DELETE /api/workspaces/:id/fs/entry`
- `POST /api/workspaces/:id/fs/move`
- `POST /api/workspaces/:id/fs/copy`
- `POST /api/workspaces/:id/fs/copy-external`
- `POST /api/workspaces/:id/fs/external`
- `POST /api/workspaces/:id/fs/external-read`
- `GET /api/workspaces/:id/fs/image`
- `GET/PUT /api/workspaces/:id/settings`

目录列表只展开请求的单层目录。默认跳过 `node_modules`、`.git`、`dist`、`build`、`.next`、
`.vite` 和 `.cache` 目录，并且默认不逐文件读取 metadata；只有 `metadata=true` 才返回文件大小
和修改时间。

路径统一接受 `/` 或 `\`，拒绝绝对路径、盘符、NUL 和 `..`。读取现有路径及最终父目录时均
规范化并检查仍位于工作区根内，因此指向工作区外的符号链接不能用于读取或写入。复制符号链接
本身及包含符号链接的目录被明确拒绝；目录也不能移动或复制到自身内部。

文本读取保持 Node 错误契约：目录、超出 `MAX_FILE_SIZE_BYTES`、包含 NUL 或不是严格 UTF-8 的
文件分别返回对应错误码。API JSON body 上限为 16 MiB，与 Node 服务一致，因此默认 5 MiB 文件
上限不会被框架默认 body limit 提前截断。

## 缓存、文件事件与并发

小型文本使用有界 LRU 缓存，默认限制为 128 项、总计 16 MiB、单项 1 MiB。缓存键为规范路径，
命中前重新比较文件大小和修改时间，因此服务外部修改不会返回过期内容。写入、移动、复制和
删除会主动使相关规范路径及子路径失效。

Windows 使用 `ReadDirectoryChangesW` 为首次读取或枚举的规范工作区根建立递归 watcher，且每个
根只注册一次。Linux 使用单个非阻塞 `inotify` worker，只注册实际读取文件的父目录和实际展开的
目录；因此不会为了 watcher 在首次打开文件时递归扫描整个项目。目录移动或删除会移除失效的
watch，最后一个 `FileService` 释放后 worker 自动退出。

两种平台的外部文件事件都会按路径主动失效对应缓存；事件缓冲区溢出时失效相关工作区缓存。
watcher 不建立搜索索引，启动或注册失败时仍由命中前的 size/mtime 复核保证正确性。当前 Windows
事件测试已实机通过；Linux 条件编译测试已经加入，CI 的独立 `Linux Rust` job 会执行 check、
严格 clippy、测试和 release 文件基准。本次开发机未安装 Linux Rust 目标且没有可用的
WSL/Docker Linux 环境，因此该 job 的远端结果仍是 P4 关闭前的必要门槛。

文件读取和目录枚举使用独立 semaphore，默认上限分别为 32 和 8；等待 future 被取消时自动
释放排队。写入及结构变更在共享服务内串行化，文件内容通过唯一临时文件、flush/fsync 和平台
原子替换发布。

文本响应返回弱 `ETag`、修改时间、`Server-Timing`、`x-osheep-file-open-id` 和真实的
`x-osheep-file-cache: hit|miss|bypass`。`If-None-Match` 命中时返回 304，现有前端会复用已缓存
响应体。图片响应同样支持 ETag 和 304。

文件读取达到 250 ms 时还会返回 `x-osheep-file-io-diagnostic`。分类优先识别 Windows UNC/映射
网络盘，其次识别 OneDrive 环境目录及 `OSHEEP_SYNC_ROOTS` 配置目录，最终区分为 `normal`、
`slow-network`、`slow-sync` 或 `slow-local`。前端把该标签与 cache 状态一并写入
`file_open_interactive` 性能事件；诊断仅用于观测，不改变请求结果。

## 性能结果

2026-08-28 在当前 Windows 开发机以 release 构建运行：

```powershell
cargo test -p osheep-server --test file_performance --release --locked --offline -- --ignored --nocapture
```

结果为 Rust Router 到完整 JSON body 接收完成的本地 HTTP 路径，不包含 Monaco 渲染：

| 文件 | 冷读 p50/p95 | 热读 p50/p95 |
| --- | --- | --- |
| 1 KiB | 1.77 / 3.35 ms | 1.07 / 2.25 ms |
| 100 KiB | 1.80 / 3.04 ms | 1.26 / 3.90 ms |
| 1 MiB | 4.53 / 6.14 ms | 3.43 / 7.64 ms |

三档均通过 P4 的冷读 p95 < 250 ms、热读 p95 < 100 ms 门槛。debug 构建的 1 MiB 热读 p95
为 113.31 ms，因此正式性能门槛只在 release 构建断言；debug 仍保留 250 ms 回归保护。

## 已覆盖测试

- 浅层目录枚举、忽略目录以及 metadata 按需读取。
- 文本缓存 miss/hit、写后失效、ETag 304 和修改后 ETag 变化。
- NUL、非法 UTF-8、超限文件、目录误读和路径穿越错误码。
- 工作区根保护、文件/目录创建、移动、复制、递归删除及目录自复制拒绝。
- 3 MiB JSON 文本写入、Base64 二进制写入、图片读取、外部预览和外部复制。
- 工作区创建布局和工作区设置读写。
- Windows 外部写入事件主动使文本缓存失效；同一事件测试会在 Linux 目标验证 `inotify` 路径。
- Unix 测试验证工作区外符号链接不可读写，并固定 Linux 路径大小写语义。
- 分类测试覆盖慢本地、同步目录和 UNC 网络路径。
- 文件打开性能事件保留 `bypass`，并解析/校验慢 I/O 诊断标签。
- 1 KiB、100 KiB、1 MiB release HTTP 延迟基准。

## P4 延期验证

- 等待新增 `Linux Rust` CI job 首次实际通过；实现与验收命令已经提交到工作流，但本轮因开发机
  缺少 Linux Rust 目标、WSL 发行版和可用 Docker daemon，不能把 Windows 检查冒充为 Linux
  验证。
- 在真实 Windows Defender、OneDrive、UNC 和映射网络盘环境采集慢 I/O 分类结果；目前分类与
  性能事件链路已有自动测试，但未虚报这些外部环境的实机结果。
- Linux CI 已接入符号链接、路径大小写和 release 性能矩阵，远端结果通过后再关闭这些项目。
- 搜索并发池、索引和文件事件消费属于 P5；当前 P4 已将交互式读取与目录枚举分池，避免二者
  相互占满配额。
