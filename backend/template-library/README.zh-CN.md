# 工作流模板库

[English](README.md) | 简体中文

内置模板位于 `system/<template-id>/template.json`，用户模板位于运行时目录 `backend/.osheep/templates/user`。

## 内置模板设计原则

- **运行时开头，Markdown 结尾**：每条链路由“工作流运行时”启动，紧接一个 Input，最终结果统一在 Markdown 块中查看。
- **短链路优先**：能用一次代理完成的任务，不增加额外代理和中间步骤。
- **Claude Code 做高价值思考**：用于项目规划、疑难根因分析和最终审查。
- **Codex 做快速执行**：用于代码检索、实现、测试和明确问题的批量修正。
- **提示词显式传递上下文**：代理块直接引用必要的上游输出，避免依赖隐式会话状态。
- **复杂度分级**：小任务使用 Codex 单代理；普通功能使用 Claude 规划 + Codex 实现；高风险任务才启用审查修正闭环。

## 当前内置模板

| 模板 | 适用场景 | 核心链路 |
| --- | --- | --- |
| 极速编码 | 小改动、明确需求 | 运行时 → Input → Codex → Markdown |
| 代码审查报告 | 只读评审、风险检查 | 运行时 → Input → Codex 扫描 → Claude 审查 → Markdown |
| 规划后实现 | 普通功能开发 | 运行时 → Input → Claude 规划 → Codex 实现 → Markdown |
| 复杂功能闭环 | 跨模块、高风险功能 | 运行时 → Input → Claude 规划 → Codex 实现 → Claude 审查 → Codex 修正 → Markdown |
| 疑难 Bug 修复 | 根因不明确、复现困难 | 运行时 → Input → Codex 取证 → Claude 诊断 → Codex 修复 → Markdown |
| 提交前自动收尾 | 提交前检查和修正 | 运行时 → Input → Git 状态 → Claude 审查 → Codex 修正 → diff-check → Markdown |
| 测试补全 | 单测、回归测试、边界测试 | 运行时 → Input → Claude 测试策略 → Codex 编写测试 → Markdown |
| 在线文档驱动开发 | 根据公开 API/框架文档编码 | 运行时 → Input(JSON) → URL 提取 → 网页正文 → Claude 方案 → Codex 实现 → Markdown |

## 开发者说明

使用 `dev-developer.cmd` 启动 osheep 后，可在开发者模式下保存、编辑或删除内置模板。系统模板的变更会同步到本目录，便于提交和分发。

可通过以下环境变量调整模板目录：

- `OSHEEP_TEMPLATES_ROOT`：运行时模板库根目录。
- `OSHEEP_SYSTEM_TEMPLATES_ROOT`：内置模板源码目录。
