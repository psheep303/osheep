# Osheep

[![CI](https://github.com/psheep303/osheep/actions/workflows/ci.yml/badge.svg)](https://github.com/psheep303/osheep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

Osheep 是一个以 AI 工作流为中心的本地开发工作台。它把代码编辑、终端、搜索、Git、工作流模板以及 Codex / Claude Code 集成放进同一个界面，支持在 Linux/Windows 上以 Web 应用运行，或以 Windows 桌面应用运行。

> 项目仍处于早期开发阶段，接口、配置格式和交互可能发生不兼容变更。当前优先支持单机、单用户场景，请勿直接将后端暴露到不可信网络。

## 功能

- 基于 Monaco Editor 的文件浏览与代码编辑
- 基于 xterm.js 和 node-pty 的集成终端
- 项目内搜索、Git 状态、差异与提交历史查看
- 可编排、可复用的 AI 工作流和模板库
- Codex 与 Claude Code 的配置、会话和插件管理
- Linux/Windows Web 开发环境与 Tauri 2 Windows 桌面壳
- 本地优先：工作区、AI CLI 配置和凭据保留在运行 Osheep 的机器上

## 架构

```text
React + Vite
     |
     | HTTP / WebSocket
     v
Fastify + node-pty  ----> 文件系统 / Git / AI CLI
     ^
     |
Tauri 2 + WebView2（Windows 桌面版）
```

桌面版会将 Node.js 后端作为 sidecar 启动，并由后端提供构建后的前端资源。Rust 进程只负责桌面窗口和后端子进程的生命周期。

## 环境要求

Web 开发需要：

- Node.js 20 或更高版本（建议使用当前 LTS）
- npm
- Git
- Linux 上编译 `node-pty` 所需的 `build-essential` 与 Python 3
- Windows 上编译 `node-pty` 所需的 C++ 构建工具
- 可选：已安装并登录的 Codex CLI 或 Claude Code CLI

构建 Windows 桌面版还需要：

- Rust stable 与 Cargo
- Visual Studio 2022 Build Tools，并安装“使用 C++ 的桌面开发”工作负载
- Microsoft Edge WebView2 Runtime

## 快速开始

Ubuntu 22.04/24.04 可先安装系统依赖：

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 git
```

安装 Node.js 20+ 后，克隆项目并安装依赖：

```bash
git clone https://github.com/psheep303/osheep.git
cd osheep
npm --prefix backend ci
npm --prefix frontend ci
```

在 Linux 上从仓库根目录启动前后端：

```bash
chmod +x ./dev.sh
./dev.sh
```

脚本会在同一终端管理两个进程。可用 `--backend-only`、`--frontend-only`、`--developer` 或 `--install` 调整启动行为，按 `Ctrl+C` 会同时停止前后端。

Windows 的安装与启动方式：

```powershell
git clone https://github.com/psheep303/osheep.git
cd osheep

cd backend
npm ci
cd ..\frontend
npm ci
cd ..
```

```powershell
.\dev.ps1
```

启动后访问：

- 前端：<http://127.0.0.1:5173>
- 后端：<http://127.0.0.1:4178>
- 健康检查：<http://127.0.0.1:4178/api/health>

两个平台也都可以分别启动：

```bash
cd backend
npm run dev
```

```bash
cd frontend
npm run dev
```

内置工作流模板的作者模式使用：

```powershell
.\dev-developer.cmd
```

## Windows 桌面版

检查 Tauri 环境：

```powershell
cd desktop
npm ci
npx tauri info
```

从仓库根目录启动桌面开发版或构建 NSIS 安装包：

```powershell
.\desktop-dev.cmd
.\desktop-build.cmd
```

安装包输出到 `desktop/src-tauri/target/release/bundle/nsis/`。更完整的打包、日志和远程模式说明见 [desktop/README.md](desktop/README.md)。

## 配置

后端从环境变量读取运行配置。可复制 [backend/.env.example](backend/.env.example) 作为参考，但程序不会自动加载 `.env` 文件；请通过 shell、进程管理器或部署平台注入变量。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OSHEEP_HOST` | `127.0.0.1` | 后端监听地址 |
| `OSHEEP_PORT` | `4178` | 后端监听端口 |
| `WORKSPACES_ROOT` | `backend/workspaces` | 工作区父目录 |
| `MAX_FILE_SIZE_BYTES` | `5242880` | 单文件读写上限 |
| `MAX_TERMINAL_SESSIONS` | `16` | 最大并发终端数 |
| `TERMINAL_IDLE_TIMEOUT_MS` | `0` | 终端空闲超时，`0` 表示禁用 |
| `AGENT_STALL_TIMEOUT_MS` | `1800000` | AI CLI 无输出超时，`0` 表示禁用 |
| `CORS_ORIGIN` | 本地回环来源 | 逗号分隔的额外可信前端来源 |
| `OSHEEP_AUTH_TOKEN` | 本地随机生成 | 非本地监听时必需的共享访问令牌 |
| `OSHEEP_TEMPLATES_ROOT` | `backend/.osheep/templates` | 运行时模板目录 |
| `OSHEEP_CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 配置目录 |
| `OSHEEP_CODEX_CONFIG_DIR` | `~/.codex` | Codex 配置目录 |

本地模式会自动建立受 Origin 限制的 `HttpOnly` 会话，API 和终端 WebSocket 不接受未授权页面访问。非本地监听必须同时配置至少 32 字符的随机 `OSHEEP_AUTH_TOKEN` 和明确的 `CORS_ORIGIN`，并使用 HTTPS；首次访问使用 `https://host/#osheep-token=TOKEN` 交换会话，令牌随后会从地址栏移除。共享令牌只适合受控的单用户部署，不能替代多用户认证、反向代理访问控制和防火墙规则。

## 数据与密钥

- 不要提交 `.env`、`backend/.osheep/`、`.codex/`、`.claude/`、私钥、证书私钥或云服务凭据。
- Osheep 的 AI 设置可能包含明文 API Key。只在受信任的本机使用，并确保配置目录权限合理。
- `.gitignore` 只能防止新的误提交，无法从 Git 历史中删除已经提交的秘密。发生误提交后应立即吊销密钥，再清理历史。
- 提交前运行 `node scripts/check-public-repo.mjs`，公开前再用 Gitleaks 扫描完整 Git 历史。

安全问题的私密报告方式见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 项目结构

```text
backend/                 Fastify API、PTY、Git 与 AI CLI 集成
frontend/                React/Vite 工作台
desktop/                 Tauri 2 桌面壳与发布脚本
backend/template-library 内置工作流模板
.osheep/                 本地运行状态与开发上下文（Git 忽略）
docs/                    面向用户、贡献者和维护者的公开文档
```

公开指南及文档边界说明请参阅[文档索引](docs/README.md)。

## 验证

在 Linux 上可执行与 CI 相同的干净安装、Bash/Git/node-pty/AI CLI 探测、测试和构建流程：

```bash
bash scripts/verify-linux.sh
```

通用的本地验证命令：

```bash
npm --prefix backend run lint
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
```

## 参与贡献

问题反馈和 Pull Request 都欢迎。开始前请阅读 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)，安全漏洞请不要提交公开 Issue。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
