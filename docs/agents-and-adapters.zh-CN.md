# Agent、Skills、模板与 Adapter

## 使用 Agent，但不被锁定

Agent 块为工作流提供 Agent 的推理与执行能力。Osheep 当前自带 Codex CLI 和 Claude Code Adapter。在块检查器中选择模型与权限设置，即可在当前工作区运行。

画布不假设未来 Agent 的行为必须和它们相同。它根据 Adapter 声明的能力工作：会话、流式输出、审批、中断、模型选择、工作目录和用量。工作流可以聚焦任务本身，而不是绑定某家 CLI。

## Skills 与插件

使用 **Codex skills** 或 **Claude skills** 块，为接下来的 Agent 步骤选择启用的 Skills。在 **Settings** 管理个人 Skill；包含 `SKILL.md` 的本地目录可以导入。

使用对应的插件块，为 Agent 步骤选择要启用的已发现插件。选择会写入底层 CLI 配置，因此只启用你信任的插件与 Skills。

## 模板与模板市场

在 **Templates** 中从内置或个人工作流开始。模板会作为可自由修改的工作区工作流打开。完成后可将工作流保存为个人模板复用。

**Template marketspace** 从 [Osheep 模板市场注册表](https://github.com/psheep303/osheep-template-registry) 读取模板。安装后，工作流和 README 会下载到本地系统模板库。需要示例或制作公开模板时，请参考 [osheep-template](https://github.com/psheep303/osheep-template)。

运行外部模板前请先审阅内容，尤其是可能修改文件、访问网络或执行命令的块。

## Remote MCP

**MCP** 块会连接 Remote MCP 服务，发现其工具并调用选中的工具。填写服务 URL、可选请求头或 API Key，点击 **Connect**，然后选择工具并填写 JSON 参数。参数可以引用工作流结果。

Remote MCP 调用会使用该服务被授予的凭据和权限。请将工具端点与模板参数视为可执行的集成配置。

## 什么是 Osheep Adapter

**Osheep Adapter** 是特定 Agent 或 Harness 与工作流运行时之间的小型后端边界。它负责原生 CLI、HTTP 或 SDK 细节，并输出统一的会话与事件。工作流运行时看到的是一致的事件，例如助手输出、工具开始/完成、审批、等待、成功与失败。

这使 Osheep 能接入新的 Agent，而不需要为每一种集成新增一类专用块。Adapter 会准确声明它支持的能力，因此 UI 与运行时能够如实处理恢复、权限、流式输出、中断与用量。

要向仓库添加 Adapter，请阅读 [Adapter 开发](adapter-development.md)。当前第三方 Adapter 必须注册到后端的显式注册表中；将一个包放进工作区不会加载其中的可执行代码。
