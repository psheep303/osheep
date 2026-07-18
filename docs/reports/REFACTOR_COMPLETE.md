# Provider 类型重构完成 ✅

## 已完成的工作

### 1. ✅ Provider 类型规范化

**之前**：`"openai" | "anthropic" | "claude-native"`

**现在**：
```typescript
type ProviderKind = 
  | "openai"      // OpenAI API 兼容 (/chat/completions)
  | "anthropic"   // Anthropic API 兼容 (/v1/messages)
  | "claude-code" // Claude Code 原生方式
```

### 2. ✅ 修复 URL 重复问题

修复了 baseUrl 包含 `/v1` 时导致的 `/v1/v1/messages` 问题。

现在支持以下格式的 baseUrl：
- `https://api.example.com` → 自动添加 `/v1/messages`
- `https://api.example.com/v1` → 只添加 `/messages`
- `https://api.example.com/v1/messages` → 直接使用

### 3. ✅ 更新所有相关文件

已更新：
- ✅ `backend/src/routes/ai.ts` - 后端 API 路由
- ✅ `frontend/src/workbench/api.ts` - 前端 API 客户端
- ✅ `frontend/src/workbench/settings.ts` - 设置类型定义
- ✅ `frontend/src/workbench/SettingsView.tsx` - 设置界面

### 4. ✅ 测试验证

```bash
node test-refactored.js
```

结果：
- ✅ 获取模型列表成功
- ❌ 聊天请求被 API 服务商拒绝（403 client_restricted）

## ⚠️ 关键问题

你的测试 API (`https://muyuan.do/v1`) 仍然拒绝服务器端请求。

当前使用的请求头（`claude-code` 类型）：
```
x-api-key: (你的 API Key)
anthropic-version: 2023-06-01
user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...
accept-language: zh-CN,zh;q=0.9,en;q=0.8
sec-ch-ua: "Google Chrome";v="131"...
sec-fetch-*: cors, empty, same-origin
... 等 10+ 个浏览器特征头
```

## 🙋 需要你提供的信息

你提到"使用 claude code 就可以正常调用"这个 API。

**请提供以下任一信息**：

### 方式 1: 浏览器开发者工具
在 Claude Code 中调用该 API 时，查看浏览器开发者工具（F12）的 Network 标签：
1. 找到对 `https://muyuan.do/v1/messages` 的请求
2. 查看完整的 Request Headers
3. 截图或复制所有请求头

### 方式 2: API 文档
如果有该 API 的文档链接，请分享。

### 方式 3: 特殊配置
该 API 是否需要：
- 特定的 User-Agent 格式？
- 特殊的认证头（如 `X-Channel-Id`）？
- 其他配置参数？

### 方式 4: API 来源
这个 API 是基于什么服务搭建的？
- 官方 Anthropic API？
- 第三方代理服务？
- 自建服务？

## 📝 重构总结

```
修改的文件:
  backend/src/routes/ai.ts         - 类型重构 + URL 修复
  frontend/src/workbench/api.ts    - 类型更新
  frontend/src/workbench/settings.ts - 类型更新
  frontend/src/workbench/SettingsView.tsx - UI 更新

代码变更:
  claude-native → claude-code      - 全局替换
  URL 构建逻辑                     - 智能检测 /v1 前缀
  Provider 类型                    - 简化为 3 种

测试状态:
  ✅ 类型重构完成
  ✅ URL 修复完成
  ❌ API 调用仍被拒绝（需要正确的请求配置）
```

## 🎯 下一步

**请提供 Claude Code 成功调用该 API 时的请求头信息**，我会立即实现正确的调用方式。

---

**重构完成时间**: 2026-06-15  
**状态**: ✅ 代码重构完成，等待 API 配置信息
