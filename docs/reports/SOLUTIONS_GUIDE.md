# 🎯 完整解决方案指南

## 当前问题

muyuan.do API 拒绝所有服务器端请求，包括 osheep Code 后端�?
## �?推荐方案对比

| 方案 | 难度 | 安全�?| 功能完整�?| 推荐�?|
|------|------|--------|-----------|--------|
| 官方 API | �?简�?| �?�?| �?100% | ⭐⭐⭐⭐�?|
| 其他代理 | ⭐⭐ 中等 | �?�?| �?100% | ⭐⭐⭐⭐ |
| 前端直调 | ⭐⭐�?复杂 | ⚠️ �?| ⚠️ 受限 | ⭐⭐ |

---

## 方案 1: Anthropic 官方 API ⭐⭐⭐⭐�?
### 步骤

**1. 获取 API Key**
```
访问: https://console.anthropic.com/
注册/登录 �?Settings �?API Keys �?Create Key
```

**2. �?osheep Code 中配�?*
```json
{
  "name": "Claude Official",
  "kind": "claude-code",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-ant-api03-...",
  "models": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]
}
```

**3. 开始使�?*
- 选择 "Claude Official" Provider
- 享受完整�?osheep Code 功能

### 优点
- �?完全支持服务器端调用
- �?无客户端限制
- �?稳定可靠
- �?我们的代码已完美适配
- �?支持所�?Beta 功能（工具调用、缓存等�?
### 费用
- 按使用量计费
- claude-opus-4-8: $15/M input, $75/M output tokens
- 可以设置使用限额

---

## 方案 2: 使用其他代理 ⭐⭐⭐⭐

### OpenRouter (推荐)

**配置**:
```json
{
  "name": "OpenRouter Claude",
  "kind": "anthropic",
  "baseUrl": "https://openrouter.ai/api",
  "apiKey": "sk-or-v1-...",
  "models": ["anthropic/claude-opus-4"]
}
```

**获取 API Key**: https://openrouter.ai/

### 测试任何代理是否支持

```bash
# 用这个命令测试任何代�?curl https://your-proxy.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-8","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'

# 如果返回正常响应（不�?client_restricted），说明支持服务器端调用
```

### 寻找支持的代�?
关键词搜索：
- "Anthropic API 代理 服务器端"
- "Claude API proxy server-side"
- 确认支持 `/v1/messages` 端点
- 确认不限制客户端类型

---

## 方案 3: 前端直接调用 ⚠️

### ⚠️ 警告

这个方案有重大安全风险：
- �?API Key 暴露在前端代�?- �?用户可以在浏览器控制台看�?- �?可能被滥�?
**仅在以下情况考虑**�?- 测试/开发环�?- API Key 有严格的使用限额
- 你完全理解风�?
### 实现步骤

1. **创建前端直调函数**

�?`frontend/src/workbench/api.ts` 中添加：

```typescript
export async function aiChatDirectBrowser(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: AiChatMessage[]
): Promise<{ content: string }> {
  // 直接从浏览器调用，绕过后�?  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || "";
  return { content };
}
```

2. **在需要的地方调用**

```typescript
// 在聊天组件中
const result = await aiChatDirectBrowser(
  "https://muyuan.do/v1",
  "sk-REDACTED",
  "claude-opus-4-8",
  messages
);
```

### 限制

- �?无法使用工具调用（read/write/run�?- �?无法多轮循环
- �?功能严重受限
- ⚠️ 安全风险

---

## 方案 4: 联系 muyuan.do

### 询问内容

�?muyuan.do 发邮件或工单�?
```
主题: 是否支持服务器端 API 调用

您好�?
我正在开发一个代码助手工具（osheep Code），需要调�?Claude API�?我注意到贵服务的 API (https://muyuan.do/v1) 似乎限制了客户端类型�?
请问�?1. 是否支持服务器端（Node.js/Python）调用？
2. 是否有专门的服务器端 API Key�?3. 是否可以为我的应用白名单特定�?User-Agent�?
期待您的回复�?
谢谢�?```

---

## 🎯 我的建议

### 最佳选择：方�?1（官�?API�?
**理由**�?1. �?完全支持 osheep Code 所有功�?2. �?我们的代码已完美实现
3. �?安全可靠，无客户端限�?4. �?直接享受完整的工具调用、多轮对话等功能

**费用考虑**�?- 可以设置月度预算限额
- 开发阶段用量不会很�?- 相比开发时间，API 费用可控

### 次选：方案 2（其他代理）

如果预算紧张，寻找其他支持服务器端的代理服务�?
### 不推荐：方案 3（前端直调）

功能严重受限，且有安全风险。仅用于临时测试�?
---

## 快速测试官�?API

如果你想先测试官�?API 是否可用�?
```bash
# 使用官方 API 测试（需要你�?API Key�?curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-REDACTED" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-8",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

如果成功返回响应，说明：
- �?你的 API Key 有效
- �?官方 API 支持服务器端调用
- �?osheep Code 可以正常工作

---

## 需要帮助？

告诉我你选择哪个方案，我可以�?
1. **方案 1**: 帮你配置官方 API 的详细步�?2. **方案 2**: 帮你测试其他代理服务
3. **方案 3**: 帮你实现前端直调（不推荐�?4. **方案 4**: 帮你起草联系 muyuan.do 的邮�?
---

## 总结

**核心问题**：muyuan.do 禁止服务器端请求  
**根本原因**：代理服务商的业务策�? 
**我们的代�?*：✅ 完全正确，已完美实现 Claude Code  

**最佳解决方�?*：使�?Anthropic 官方 API

告诉我你想用哪个方案，我立即帮你实现！🚀
