# Changelog

本项目的所有显著变更都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。项目处于 0.x 早期阶段：
次版本号（0.x.0）可能包含破坏性变更，修订号（0.x.y）为修复与小改进。

## [Unreleased]

### Added
- 新增英文 README、贡献者行为准则、Dependabot 与 Issue 配置，完善项目社区协作入口。
- 引入 Biome 代码检查与格式化基线，并在 CI 中覆盖前后端 lint 和缺失的前端测试。
- 桌面端启动时立即显示加载页，并在本地后端就绪后进入应用，同时显示启动错误。

### Changed
- Monaco Editor 与语言 worker 改为本地打包，编辑器和差异视图不再依赖 CDN。
- 重型前端视图及 Monaco、xterm、Markdown 依赖改为按需加载，显著缩小首屏入口包。
- 静态资源支持 gzip 预压缩、长期缓存与 ETag 重验证；工作流查询在 `304` 时复用本地响应。
- 系统模板仅在内置模板内容变化时重新同步，并串行化同一目标的并发模板操作。
- 生产环境后端日志改用结构化 Pino 输出，易读的 `pino-pretty` 输出仅保留在开发环境。
- 工作台颜色改由设计令牌统一驱动，并统一焦点样式、圆角、过渡与滚动条表现。

### Fixed
- 修复桌面端启动和关闭过程中的竞态，避免后端子进程泄漏、启动错误丢失或窗口关闭后继续导航。
- 修复模板路径别名、缺失目标路径及 Windows 大小写差异导致的并发读写竞态。
- 修复延迟加载终端的初始焦点与 WebSocket 清理时序。
- 清理工作台 CSS 的 UTF-8 BOM 与乱码分节注释，并增加等价性守护防止样式基线漂移。

### Removed
- 从后端生产构建中排除编译后的测试文件。
- 从 Windows 桌面发布 stage 中移除非目标平台的 `node-pty` 预构建、原生源码、后端锁文件与编译测试文件。

## [0.2.0] - 2026-07-26

### Changed
- backend / frontend / desktop 版本号统一为 0.2.0。

<!-- 发布步骤：更新本文件 → 三处 package.json + Cargo.toml + tauri.conf.json 同步版本 →
     git tag v0.2.0 && git push origin v0.2.0（由维护者手动执行） -->
