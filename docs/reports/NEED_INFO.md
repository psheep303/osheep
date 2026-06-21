# 需要确认的信息

为了正确实现"原生 Claude Code 请求方式"，我需要了解：

## 问题

你提到"使用 claude code 就可以正常调用"这个 API (https://muyuan.do/v1)。

但我测试发现该 API 会拒绝所有服务器端请求（包括curl、Node.js fetch等），错误信息：
```
"This channel does not allow the current client (detected: ...)"
```

## 需要的信息

请提供以下任一信息，以便我实现正确的请求方式：

### 方式 1: 请求头信息
在 Claude Code 中调用该 API 时，浏览器开发者工具中看到的完整请求头。

### 方式 2: API 文档
该 API 的文档链接或说明。

### 方式 3: 具体说明
该 API 需要什么特殊的：
- 认证头（如特定的 X-Channel-Id）？
- User-Agent 格式？
- 其他特殊参数？

## Provider 类型重构

同时，我会按照你的要求将 Provider 类型规范化为：

```typescript
type ProviderKind = 
  | "openai"        // OpenAI API 兼容 (/v1/chat/completions)
  | "anthropic"     // Anthropic API 兼容 (/v1/messages)
  | "claude-code";  // 原生 Claude Code 方式（你的测试 API）
```

请提供相关信息，我立即实现正确的调用方式。
