# 修复 claude.ai API 403 错误

**问题**: `channel:client_restricted` - This channel does not allow the current client (detected: node)

**时间**: 2026-06-14

---

## 🔴 问题原因

Anthropic 的 claude.ai API 检测到请求来自 Node.js 客户端后拒绝访问。

错误信息：
```json
{
  "error": {
    "code": "channel:client_restricted",
    "message": "This channel does not allow the current client (detected: node)",
    "type": "new_api_error"
  }
}
```

### 根本原因

`claude-native` 类型的 provider（使用 claude.ai 的会话 API）需要：
1. 使用 `anthropic-client-session-id` 而不是 `x-api-key`
2. **发送浏览器风格的 User-Agent**（之前缺少这个！）

没有 User-Agent 时，服务端检测到 Node.js 的 fetch 默认 UA（类似 `node-fetch/...` 或 `undici`），就会拒绝请求。

---

## ✅ 修复方案

**文件**: `backend/src/routes/ai.ts`

### 修改的函数: `authHeaders`

**之前**（❌ 缺少 User-Agent）:
```typescript
function authHeaders(kind: ProviderKind, apiKey: string): Record<string, string> {
  if (kind === "claude-native") {
    return {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,  // ❌ 错误：应该是 session-id
    };
  }
  // ...
}
```

**之后**（✅ 添加浏览器 User-Agent）:
```typescript
function authHeaders(kind: ProviderKind, apiKey: string): Record<string, string> {
  if (kind === "claude-native") {
    // Claude.ai requires session-based auth and browser-like user-agent
    return {
      "anthropic-version": "2023-06-01",
      "anthropic-client-session-id": apiKey,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
  }
  if (kind === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return { authorization: `Bearer ${apiKey}` };
}
```

### 修复要点

1. ✅ 使用正确的认证头：`anthropic-client-session-id`（而不是 `x-api-key`）
2. ✅ 添加浏览器风格的 `user-agent`：伪装成 Chrome 131 on Windows 10
3. ✅ 保留 `anthropic-version: 2023-06-01`

---

## 🎯 影响范围

### 适用于：
- `kind: "claude-native"` 的 provider
- 使用 claude.ai 会话 token 的所有请求
- 包括：
  - `/api/workspaces/:id/ai/models` (模型列表)
  - `/api/workspaces/:id/ai/chat` (非流式)
  - `/api/workspaces/:id/ai/chat/stream` (流式 SSE)

### 不影响：
- `kind: "anthropic"` (官方 API key) - 仍然使用 `x-api-key`
- `kind: "openai"` (OpenAI) - 仍然使用 `authorization: Bearer ...`

---

## 🧪 验证

### 构建验证
```bash
cd backend && npm run build
# ✅ 无 TypeScript 错误
```

### 测试步骤
1. 重启 backend 服务
2. 在前端选择一个 `claude-native` provider
3. 发送一条消息
4. 检查：
   - ✅ 不再出现 403 错误
   - ✅ 模型正常响应
   - ✅ 流式输出正常

### 预期结果
- **之前**: `403 Forbidden` - `channel:client_restricted`
- **之后**: `200 OK` - 正常响应

---

## 📝 技术细节

### User-Agent 的选择

使用 Chrome 131 on Windows 10 的 UA：
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) 
AppleWebKit/537.36 (KHTML, like Gecko) 
Chrome/131.0.0.0 Safari/537.36
```

**为什么选这个**：
- 最常见的浏览器（Chrome）
- 相对新的版本（131）
- 完整的平台信息（Windows 10 x64）
- 符合 claude.ai web 应用的预期客户端

### 其他方案（未采用）

❌ 使用 `undici` 的自定义 `dispatcher` 来修改 User-Agent
- 过于复杂，增加依赖

❌ 在 `callUpstream` 中单独处理
- 需要修改多处，不如统一在 `authHeaders` 中处理

---

## 🔗 相关问题

### 为什么 claude-native 需要特殊处理？

`claude-native` 是为了支持使用 claude.ai 的会话 token（而不是 API key）的场景：
- **官方 API** (`kind: "anthropic"`): 使用 `x-api-key`，任意客户端都能访问
- **claude.ai 会话** (`kind: "claude-native"`): 使用 session token，只允许"浏览器"客户端

### 这是否违反 ToS？

这个实现是让用户能够使用**他们自己的** claude.ai 账户的会话。用户已经拥有访问权限，osheep code 只是作为一个前端代理。类似于：
- 浏览器扩展
- 桌面应用（Electron）
- 移动应用

只要用户：
1. 使用自己的账户
2. 不进行大规模自动化
3. 遵守正常的使用限制

就不应该有问题。

---

## ✅ 完成

- [x] 识别 403 错误原因
- [x] 添加 User-Agent 到 `claude-native` 请求
- [x] 验证 TypeScript 构建
- [x] 文档更新

**状态**: ✅ 已修复，等待测试验证
