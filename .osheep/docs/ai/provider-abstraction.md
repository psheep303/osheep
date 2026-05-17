# LLM Provider 抽象

## 目标

支持 osheep 在不改动上层流程的前提下切换不同模型提供方。

---

## 设计原则

1. 上层流程只关心能力，不关心具体厂商
2. Provider 必须支持流式输出
3. Provider 必须支持统一消息输入结构
4. Provider 配置应来自项目设置或服务端配置
5. 后续可扩展工具调用能力

---

## 最小能力接口

### chat
用于普通对话与文档修订

### generateStructured
用于生成结构化结果，例如：
- 文档摘要
- 待确认项
- Todo 列表

### stream
用于前端实时显示生成过程

---

## 当前阶段要求

- 先支持一个主力 Provider
- 保留扩展多个 Provider 的接口
- 不在业务流程中写死供应商逻辑

---

## Provider 配置存储

Provider 列表存放在 `.osheep/settings.json` 的 `ai.providers` 字段，由设置页面维护。每个 Provider 记录包含：

- `id`：Provider 内部标识，前端生成
- `name`：展示名
- `baseUrl`：OpenAI 兼容接口的根地址
- `apiKey`：访问该 Provider 所需的密钥
- `models`：可调用的模型 ID 列表

Agent（见 `frontend/agent-page.md`）通过 `providerId` + `model` 引用一个具体的 Provider 模型组合。
