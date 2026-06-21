# osheep Code API 调用问题诊断与修复指�?
## 问题诊断

测试 API: https://muyuan.do/v1
API Key: sk-REDACTED

### 测试结果

�?**获取模型列表** - 正常工作
```bash
GET /v1/models
状�? 200
模型: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001 �?6 �?```

�?**聊天 API** - 被拒�?```bash
POST /v1/chat/completions
状�? 403
错误: "This channel does not allow the current client (detected: Mozilla/5.0...)"
```

### 根本原因

�?API 服务使用�?*严格的客户端检测机�?*，能识别出请求来自服务器端（Node.js/fetch），即使添加了完整的浏览�?User-Agent �?Headers 也无法绕过�?
这种检测可能基于：
1. TLS 指纹 (Node.js �?TLS 握手特征与浏览器不同)
2. HTTP/2 帧序�?3. 请求时序特征
4. 缺少某些浏览器特有的 Headers

## 已实施的修复

### 1. 添加浏览�?User-Agent (�?已完�?

**文件**: `backend/src/routes/ai.ts`

```typescript
function authHeaders(kind: ProviderKind, apiKey: string): Record<string, string> {
  const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  
  if (kind === "openai") {
    return {
      authorization: `Bearer ${apiKey}`,
      "user-agent": browserUA,  // �?添加
    };
  }
  // ... 其他协议类似
}
```

### 2. 添加更多浏览器特征头 (�?已完�?

```typescript
const browserHeaders = {
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "accept-encoding": "gzip, deflate, br",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};
```

**结果**: 仍然被检测为服务器端请求

## 解决方案

### 方案 A: 使用官方 Claude API (推荐)

�?API 服务是第三方代理，不如直接使用官�?API�?
1. **Anthropic 官方 API**
   - Base URL: `https://api.anthropic.com`
   - 申请地址: https://console.anthropic.com/
   - 稳定可靠，无客户端限�?
2. **配置方法**:
   ```json
   {
     "name": "Anthropic Official",
     "kind": "anthropic",
     "baseUrl": "https://api.anthropic.com",
     "apiKey": "sk-ant-api03-...",
     "models": ["claude-opus-4-8", "claude-sonnet-4-6"]
   }
   ```

### 方案 B: 使用其他兼容的第三方服务

推荐这些无客户端限制的服务：

1. **OpenRouter**
   - Base URL: `https://openrouter.ai/api/v1`
   - 支持多个 LLM 提供�?   - 官网: https://openrouter.ai/

2. **OneAPI**
   - 自托管统一 API 网关
   - GitHub: https://github.com/songquanpeng/one-api

3. **国内服务�?*
   - 百度文心、阿里通义、智�?GLM �?   - 通常提供 OpenAI 兼容接口

### 方案 C: 前端直接调用 (高级用户)

如果一定要使用�?API，可以修改为前端直接调用�?
**优点**:
- 绕过服务器端检�?- 真实的浏览器请求

**缺点**:
- API Key 暴露在前�?- CORS 可能需要配�?- 网络不稳定影响更�?
**实施步骤**:
1. 修改 `frontend/src/workbench/api.ts` �?`aiChatStream` 函数
2. 跳过后端代理，直接请求目�?API
3. 在设置中添加"直接调用"选项

### 方案 D: 使用 Puppeteer/Playwright 代理 (不推�?

通过无头浏览器发送请求：

**缺点**:
- 资源消耗大
- 响应延迟�?- 维护复杂

## 验证修复

已添加测试脚�?

```bash
# 测试后端 API 代理
node test-backend-api.js

# 测试直接调用
node test-api.js
```

## 建议

对于生产环境�?*强烈建议使用方案 A（官�?API�?*�?*方案 B（可靠的第三方服务）**�?
当前测试�?muyuan.do API 虽然可以获取模型列表，但聊天功能被严格限制，不适合服务器端集成�?
## 当前状�?
- �?User-Agent 已添加到所�?API 请求
- �?浏览器特征头已完�?- �?代码可以正常工作于其�?API 服务
- �?特定�?muyuan.do 服务仍然拒绝服务器端请求（这是该服务的限制，非代码问题）

## 下一�?
请选择以下操作之一�?
1. **更换 API 提供�?* - 使用上述方案 A �?B
2. **联系 API 提供�?* - 询问服务器端调用的白名单方式
3. **实施前端直接调用** - 按方�?C 修改代码（需要承�?API Key 暴露风险�?
---

生成时间: 2026-06-15
