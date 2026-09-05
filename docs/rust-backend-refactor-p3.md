# Rust 后端重构 P3 实施记录

P3 第一批建立了共享 Rust 服务的实例协议、桌面发现链路、客户端租约和用户数据迁移。由于 Rust
服务尚未实现全部业务 API，桌面默认仍使用 Node；设置 `OSHEEP_BACKEND_MODE=rust` 才启用共享
Rust 服务路径。两种模式按整套服务切换，不按路由混合代理。

## 共享实例协议

新增 `osheep-instance` crate，负责：

- `service.lock` 平台原生独占锁：Windows `LockFileEx`，Unix `flock`。
- `service.json` 登记 PID、服务版本、回环地址、启动时间和 64 字符随机 token。
- 校验 schema、版本、非零 PID、回环 socket 和 token 强度。
- 临时文件、`fsync` 和 rename 发布登记；服务正常退出时只删除匹配自身 PID/token 的登记。
- Unix runtime 目录和文件分别限制为 `0700`/`0600`；Windows 使用应用用户数据目录继承的当前
  用户 ACL。

Rust server 在配置 `OSHEEP_RUNTIME_DIR` 时进入 managed-service 模式：只允许回环地址，可使用
`OSHEEP_PORT=0` 绑定随机端口，并在监听成功后发布登记。抢锁失败的竞争实例直接退出，不覆盖
当前服务登记。

## 客户端与回收

managed-service 提供仅 private bearer token 可调用的内部接口：

- `GET /api/runtime/health`
- `POST /api/runtime/clients`，同时用于注册和心跳续租
- `DELETE /api/runtime/clients/:id`

Tauri 校验登记和 health 返回的 PID/version 一致后注册随机客户端 ID，并按 lease timeout 的三分
之一发送心跳。窗口进程退出时注销；异常退出的客户端在 lease 过期后被清理。最后一个客户端
消失后，服务默认等待 10 秒再退出。默认 lease 为 45 秒，可分别通过
`OSHEEP_SERVICE_IDLE_TIMEOUT_MS` 和 `OSHEEP_CLIENT_LEASE_TIMEOUT_MS` 调整。

多个桌面进程可同时读取同一登记并连接同一 Rust server。若同时发现无服务，允许它们竞争启动，
最终只有持有锁的 server 留存，其他进程随后复用胜出的登记。

## 桌面与打包

- `desktop/scripts/prepare-dev.ps1` 构建并 stage debug `osheep-server.exe`。
- `desktop/scripts/prepare-release.ps1` 构建并 stage release `osheep-server.exe`。
- Tauri 资源新增 `sidecar/osheep-server.exe`；Node 资源暂时保留用于默认模式和回退。
- Rust 模式不把 server 作为当前窗口拥有的子进程；独立 reaper 等待启动尝试退出，服务生命周期
  由锁和客户端租约决定。

## 数据所有权与迁移

Rust 模式使用 Tauri 应用用户数据目录下的 `data/`，工作区位于 `data/workspaces/`。首次启动时：

- 从 Node `.osheep` 复制文件到 Rust 数据目录并逐文件校验，不删除或修改 Node 原数据。
- 若旧桌面版本已在应用用户数据根目录创建 `workspaces/` 和 `workspace-root.json`，也将其复制到
  `data/`，并保留原目录用于回退。
- 目标已有不同内容时保留目标，并把源副本写入 `migration-conflicts/node-data-*`。
- 重写默认 workspace root 时使用平台原子替换。
- 全部成功后分别原子写入 `migration-node-v1.json` 或 `migration-appdata-v1.json`；存在对应标记时
  不重复迁移。

因此 Node 回退版本仍可读取原数据，Rust 与 Node 不会同时写同一个数据目录。

Rust server 通过 `OSHEEP_DATA_ROOT` 独占该数据目录，并在启动时创建 `templates/` 运行时目录。
`workspace-root.json` 中已持久化的绝对路径优先于启动时的 `WORKSPACES_ROOT` 默认值，因此服务
重启后保持用户选择。Tauri Rust 模式显式传入数据根并允许桌面选择外部工作区；普通 Web 模式
默认不开放外部路径切换。

`osheep-core::StateStore` 负责 `settings.json`、`workspace-root.json` 和
`opened-projects.json`。同一共享服务内的读改写操作通过异步互斥锁串行化；写入使用唯一临时
文件、flush/fsync 和平台原子替换，避免多个窗口同时更新时丢字段或留下半份 JSON。打开工作区
时由共享服务记录最近项目，路径按平台规则去重。

本批已由 Rust 直接提供以下现有前端契约：

- `GET/PUT /api/settings`
- `GET/PUT /api/ui-preferences`
- `GET/PUT /api/dismissed-confirmations`
- `GET /api/workspaces`
- `GET/POST /api/workspaces/root`
- `GET /api/workspaces/:id`，并持久化最近项目

完整文件操作、工作区创建和模板读取/编辑/市场安装仍按 P4/P6 迁移，不在 P3 通过混合代理
接入 Node。模板运行时目录及迁移目标已经归 Rust 数据根所有，但模板业务 API 尚未迁移。

## 已覆盖测试

- 锁互斥、登记发布/清理、陈旧登记替换。
- schema、版本、PID、回环地址和 token 校验。
- 无 token 拒绝、客户端版本冲突、attach 刷新、detach 和 lease 过期。
- 两个 server 并发启动只保留一个实例。
- 端口占用时不发布登记。
- server 被强制终止留下登记后，下一实例取得锁并替换 PID/token。
- 最后客户端注销后 server 自动退出并移除登记。
- Tauri health 请求验证 bearer、PID 和版本。
- Node 到 Rust 数据复制、冲突保留、workspace root 重写、迁移标记和源数据保留。
- 旧应用用户数据根目录到 `data/` 的复制、冲突保留、workspace root 重写、迁移标记和源数据保留。
- 设置并发更新串行化、原子 JSON 替换和临时文件清理。
- 设置、UI 偏好、确认项、工作区列表/打开/根目录切换的 HTTP 契约和持久化格式。
- 最近项目路径去重，以及服务重启时恢复已持久化的工作区根。

## P3 剩余工作

- 在真实两个/三个 Tauri GUI 进程下验证服务复用、窗口退出顺序、异常终止和升级体验。
- Rust 尚未拥有工作区文件、创建工作区和模板业务 API；完成对应迁移前 Rust 桌面模式只用于
  P1/P2/P3 集成验证，不能作为默认桌面后端。
- 完成 Windows 安装包升级/降级测试，并验证 runtime 目录 ACL 和安装包不遗漏 Rust server。
- 对运行中的旧版本服务提供明确的升级协调 UI；当前检测到健康但版本不匹配时拒绝连接，等待旧
  客户端退出和服务空闲回收，不会强杀其他窗口正在使用的服务。
- 补 Linux Web managed-service 验证；Linux 桌面仍不属于当前发布承诺。
