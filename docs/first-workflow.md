# 第一个工作流

简体中文 · [English](first-workflow.en.md)

下面搭建一个小而可审查的编码闭环。它使用你已安装的任一内置 Agent Adapter。

## 1. 创建链路

打开 **Workflow**，新建工作流，并添加、连接以下块：

```text
Workflow run -> Input -> Agent -> Diff approval -> Markdown
```

Agent 块可选择 Codex 或 Claude Code。它们是当前内置 Adapter，不是 Osheep 工作流能力的边界。

## 2. 编写 Agent 提示词

在 Agent 块中引用 Input 块的值：

```text
在当前工作区完成以下任务：
{{blocks[2].text}}

检查改动的文件，并说明你做了什么。
```

画布上显示了块编号。后续块需要使用前面结果时，写一个输出引用即可。

## 3. 选择权限

根据任务选择合适的权限或沙箱模式。先使用能完成任务的最低权限，运行中随时可以停止。

## 4. 运行与审查

在 **Input** 填入任务并点击 **Run**。Osheep 会流式展示 Agent 会话并记录块追踪。流程到达 **Diff approval** 后，检查变更并选择同意或拒绝。

## 5. 复用流程

打开运行详情可查看输出、重试、终端日志、Token 与费用；需要记录时可导出报告。确认流程符合预期后，将它保存为模板。

若要交付代码，可在审批块后加入 **Git commit**。若是数据流程，可将 Agent 块替换为 HTTP、JSON extract、JavaScript 或 Remote MCP 块。
