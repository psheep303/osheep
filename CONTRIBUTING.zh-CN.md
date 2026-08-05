# 参与贡献

[English](CONTRIBUTING.md) | 简体中文

感谢你参与 Osheep。项目仍在快速迭代，较大的功能改动建议先创建 Issue，说明使用场景、行为边界和实现方向，避免重复工作。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.zh-CN.md)。请在互动中保持尊重与善意。

## 开发环境

需要 Node.js 20+、npm 和 Git。Linux Web 开发还需要 Python 3 与 `build-essential` 来编译 `node-pty`；Windows 桌面版还需要 Rust、Visual Studio C++ Build Tools 与 WebView2 Runtime。

```powershell
git clone https://github.com/psheep303/osheep.git
cd osheep

cd backend
npm ci
cd ..\frontend
npm ci
cd ..\desktop
npm ci
```

Web 开发可从仓库根目录运行 `bash ./dev.sh`（Linux）或 `.\dev.ps1`（Windows）。具体启动方式和端口见 [README.zh-CN.md](README.zh-CN.md)。

## 文档语言

公开项目文档以英文为规范版本和默认语言。英文文件使用无语言后缀的名称，例如 `README.md`；简体中文使用 `.zh-CN.md`，例如 `README.zh-CN.md`。修改面向用户的文档时，应同步维护两个版本。

## 提交改动

1. 从最新主分支创建一个范围明确的分支。
2. 保持改动聚焦，不要混入无关格式化或生成文件。
3. 为共享逻辑、API 行为和缺陷修复补充相应测试。
4. 更新受影响的 README、配置示例或设计文档。
5. 提交前确认没有密钥、个人路径、会话记录和本地运行数据。

仓库卫生检查：

```powershell
node scripts/check-public-repo.mjs
```

后端验证：

```powershell
cd backend
npm run lint
npm run build
npm test
```

前端验证：

```powershell
cd frontend
npm run lint
npm run build
npm test
```

Linux 上可用 `bash scripts/verify-linux.sh` 从依赖安装开始复现完整 CI 流程。

修改桌面打包逻辑时，还应运行 `npx tauri info` 和 `./desktop-dev.cmd`。正式构建安装包前，请同步 `desktop/package.json`、`desktop/src-tauri/Cargo.toml` 与 `desktop/src-tauri/tauri.conf.json` 中的版本号。

提交 Pull Request 即表示你同意按仓库的 MIT License 授权你的贡献。

## Pull Request

PR 描述应包含改动动机、可观察行为、验证方法和必要的界面截图。存在兼容性影响、迁移步骤或已知限制时请明确说明。

请确保：

- 构建和相关测试通过；
- 新增依赖确有必要且锁文件已更新；
- 没有提交 `.env`、AI CLI 凭据、私钥、日志或工作区数据；
- 用户可见行为和配置变化已有文档。

## 安全问题

不要通过公开 Issue 或 PR 报告未修复的漏洞，也不要附带真实凭据。请按 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 中的方式私密联系维护者。
