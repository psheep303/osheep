# AI Chat / Models API

## 目标

让前端通过后端代理调用 OpenAI 兼容的 LLM 接口，避免把 API Key 暴露给浏览器跨域请求，并为后续流式输出 / 工具调用预留入口。

当前阶段提供两个非流式接口：
- 拉取 Provider 可用模型清单
- 转发一次 chat completion 请求

---

## `POST /api/workspaces/:id/ai/models`

### 请求体
```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-..."
}
```

### 行为
- 后端拼接 `${baseUrl.replace(/\/+$/, "")}/models`
- 以 `Authorization: Bearer <apiKey>` 调用
- 解析 `{ data: [{ id, ... }, ...] }`，抽出 `id` 列表返回
- 若上游不是该协议、网络失败等，返回 `502 UPSTREAM_FAILED` 并附上游错误信息

### 返回
```json
{ "models": ["gpt-4o-mini", "gpt-4o", "..."] }
```

---

## `POST /api/workspaces/:id/ai/chat`

### 请求体
```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system",    "content": "你是 osheep 的需求拆解助手……" },
    { "role": "user",      "content": "..." },
    { "role": "assistant", "content": "..." },
    { "role": "user",      "content": "..." }
  ]
}
```

### 行为
- 后端拼接 `${baseUrl}/chat/completions`
- 以 `Authorization: Bearer <apiKey>` 调用
- 上游响应体为标准 OpenAI 格式，取 `choices[0].message.content` 作为助手回复
- 当前阶段不开启 streaming，前端拿到完整回复后再渲染

### 返回
```json
{
  "content": "...",
  "raw": { /* 上游原始 JSON */ }
}
```

错误：
- 缺少字段：`400 INVALID_QUERY`
- 上游 4xx / 5xx：`502 UPSTREAM_FAILED`，body 含上游消息

---

## 当前阶段不做

- 流式 / SSE
- 工具调用、函数调用
- 多模态输入
- Token / 费用统计
- 服务端缓存
- Provider 配置在服务端校验（当前由前端从 settings.json 取出再原样转发）