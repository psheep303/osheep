# Osheep 文档

Osheep 将 Agent、Harness、工具和项目操作组织成简洁的可视化工作流。建议先阅读快速指南，
需要了解具体工作流块或扩展点时再查阅参考文档。

简体中文 · [English](README.en.md)

## 从这里开始

- [快速开始](getting-started.md)：安装、打开工作区并运行模板。
- [第一个工作流](first-workflow.md)：用五步构建一个实用的 Agent 工作流。
- [Agent、Skills、模板与 Adapter](agents-and-adapters.md)：了解当前集成以及 Osheep 如何支持更多扩展。

English:

- [Getting started](getting-started.en.md)
- [First workflow](first-workflow.en.md)
- [Agents, skills, templates, and adapters](agents-and-adapters.en.md)

## 参考

- [工作流块](workflow-blocks.md)：工作流块行为、输入和当前限制。
- [工作流块输出契约](workflow-block-output.md)：稳定的输出字段与模板。
- [Adapter 开发](adapter-development.md)：为其他 Agent 或 Harness 构建 Osheep Adapter。

## 仓库文档

- [贡献指南](../CONTRIBUTING.md) · [English](../CONTRIBUTING.en.md)
- [安全说明](../SECURITY.md) · [English](../SECURITY.en.md)
- [桌面应用](../desktop/README.md)
- [模板库](../backend/template-library/README.md)
- [公开发布检查清单](public-release-checklist.md)

Keep public user, contributor, architecture, security, and maintenance documentation in `docs/`.
Keep private notes, temporary plans, generated reports, and local runtime state under `.osheep/`;
that directory is intentionally ignored by Git.
