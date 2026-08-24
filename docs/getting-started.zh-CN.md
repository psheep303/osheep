# 快速开始

## 1. 启动 Osheep

安装 Node.js 20+、npm 与 Git，然后安装前后端依赖：

```bash
git clone https://github.com/psheep303/osheep.git
cd osheep
npm --prefix backend ci
npm --prefix frontend ci
```

Linux 运行 `./dev.sh`，Windows 运行 `.\dev.ps1`，再打开 <http://127.0.0.1:5173>。

Linux 还需要 Python 3 与 `build-essential` 来编译 `node-pty`；Windows 需要 `node-pty` 所需的 C++ 构建工具。

## 2. 选择工作区

通过工作区选择器打开项目文件夹或创建工作区。Osheep 会在这个工作区内运行命令和 Agent 块，因此请选择目标仓库。

## 3. 运行模板

打开 **Templates**，选择一个模板并在当前工作区打开它。在 Input 块中填写任务，点击 **Run**。这是熟悉画布最快的方式。

打开的工作流可以直接修改，不会改动源模板。常用流程可在工作流菜单中保存为个人模板。

## 4. 需要时再加入 Agent

运行 Agent 块前，请先安装并登录受支持的 Agent CLI。当前内置 Adapter 为 Codex CLI 和 Claude Code，权限控制位于 Agent 块的检查器中。

Agent 不是必需的。文件、命令、HTTP、Git、JavaScript 与 MCP 块同样会在所选工作区内本地运行。

## 5. 保持本地运行

Osheep 默认监听 `127.0.0.1`，不要暴露到不可信网络。受控的远程单用户部署必须使用 HTTPS，并明确设置 `CORS_ORIGIN` 和 `OSHEEP_AUTH_TOKEN`；安全边界见根目录 README。
