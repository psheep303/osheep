# 参与贡献 Osheep

[English](CONTRIBUTING.md) | 简体中文

Osheep 将复杂的 Agent / Harness 工作流变成轻量、可视、可控的环境。欢迎能让产品更简单、让集成更可靠、让本地优先工作流更好用的贡献。

较大的改动请先创建 Issue，说明用户问题、预期行为与实现边界。小修复、文档改进和范围明确的测试可以直接提交 Pull Request。

## 开发环境

需要 Node.js 20+、npm 和 Git。Linux Web 开发还需要 Python 3 与 `build-essential` 编译 `node-pty`；Windows 桌面开发还需要 Rust、Visual Studio C++ Build Tools 和 WebView2。

```powershell
git clone https://github.com/psheep303/osheep.git
cd osheep

npm --prefix backend ci
npm --prefix frontend ci
npm --prefix desktop ci
```

Linux 运行 `./dev.sh`，Windows 运行 `.\dev.ps1`。桌面版命令见 [README.zh-CN.md](README.zh-CN.md)。

## Pull Request

- 改动保持聚焦，不要混入无关格式化或生成文件。
- 为共享逻辑、API 行为和回归问题补充测试。
- 用户可见文档请同步更新英文和简体中文。
- 不要提交凭据、个人路径、会话、日志或工作区数据。
- 在 PR 中说明用户可见行为和验证方式；视觉改动请提供截图。
- 提交即表示你按仓库的 MIT License 授权贡献，并遵守[行为准则](CODE_OF_CONDUCT.zh-CN.md)。

提交评审前运行与改动相关的检查：

```bash
npm --prefix backend run lint
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test
node scripts/check-public-repo.mjs
```

Linux 的 `bash scripts/verify-linux.sh` 可复现 CI 流程。修改桌面端时，还需在 `desktop/src-tauri` 运行 `cargo fmt --check`、`cargo clippy --locked -- -D warnings` 与 `cargo test --locked`。

## 文档

教程应短小并围绕任务展开；详细行为放到参考文档，不要堆进首次使用流程。英文是规范版本：英文用 `README.md`，简体中文用 `.zh-CN.md`。公开文档放入 `docs/`；本地笔记和生成内容放在 `.osheep/`，不要提交。

## 模板与模板市场

[osheep-template](https://github.com/psheep303/osheep-template) 是公开模板结构和示例的参考仓库。可发布模板需要 `workflow.json` 和 `README.md`，图标可选。保持链路简短，明确权限与副作用，并在干净工作区测试。

[osheep-template-registry](https://github.com/psheep303/osheep-template-registry) 是模板市场目录。模板仓库准备好后，再在注册表中新增或更新条目。用户会将注册表条目安装到本地，因此模板内容必须易于审阅，并能在运行前明确风险。

## 开发 Osheep Adapter

**Osheep Adapter** 将一个 Agent 或 Harness 接入统一的工作流运行时。它负责原生 CLI、HTTP 或 SDK 协议，并输出统一的会话与事件；画布不应为某个新集成增加专用逻辑。

开发新 Adapter 时：

1. 定义准确的能力声明与配置 Schema。
2. 将原生流式事件映射为 Osheep 生命周期、助手、工具、审批和失败事件。
3. 将进程、HTTP 或 SDK 控制隔离在 transport 中。
4. 补齐 mapper 边界测试和通用 Adapter 契约测试。
5. 在 `backend/src/adapters/default-registry.ts` 中显式注册。
6. 记录所需安装、认证、权限和未支持的行为。

实现前请阅读 [docs/adapter-development.md](docs/adapter-development.md)。当前仓库不会因为工作区中出现第三方 Adapter 包就执行它；显式注册是刻意保留的信任边界。

## 安全

不要通过公开 Issue 或 PR 报告未修复漏洞。私密报告方式见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。
