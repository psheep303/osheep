# 使用 Claude Native API

osheep code 现在支持三种 Provider Kind�?
1. **openai** - OpenAI 兼容�?`/chat/completions` 端点
2. **anthropic** - Anthropic Messages API (`/v1/messages`) 带代理兼容�?3. **claude-native** - �?Anthropic Messages API（Claude Code 风格�?
## 为什么需�?claude-native�?
某些 Anthropic 兼容代理不支�?`Authorization: Bearer` 头，只接�?`x-api-key`。`claude-native` 模式专门为这类端点设计，使用与官�?Claude API 完全一致的请求格式�?
## 配置示例

### 方法 1：通过设置页面

1. 打开 osheep 设置页面
2. �?AI Providers 区域点击「添�?Provider�?3. 填写�?   - Name: `Claude Proxy`
   - Kind: 选择 `claude-native`
   - Base URL: `https://muyuan.do`
   - API Key: `sk-REDACTED`
4. 点击「拉取模型列表�?5. 保存

### 方法 2：直接编辑配置文�?
编辑 `<workspace>/.osheep/settings.json`�?
```json
{
  "ai": {
    "providers": [
      {
        "id": "prov_claude_native",
        "name": "Claude Proxy",
        "kind": "claude-native",
        "baseUrl": "https://muyuan.do",
        "apiKey": "sk-REDACTED",
        "models": ["claude-opus-4-20250514", "claude-sonnet-4-20250514"]
      }
    ],
    "defaultProviderId": "prov_claude_native",
    "defaultModel": "claude-sonnet-4-20250514"
  }
}
```

## 三种模式的区�?
| Kind | 端点 | 请求�?| 用�?|
|------|------|--------|------|
| `openai` | `/chat/completions` | `Authorization: Bearer <key>` | OpenAI / 兼容代理 |
| `anthropic` | `/v1/messages` | `x-api-key` + `Authorization` 双重 | 官方 Claude API + 部分代理 |
| `claude-native` | `/v1/messages` | �?`x-api-key` | �?Anthropic 风格代理 |

## 推理支持

`claude-native` 模式完全支持 extended thinking（扩展思考）�?
- `off` - 不启用思�?- `low` - 4096 tokens 预算
- `medium` - 16384 tokens 预算
- `high` - 32768 tokens 预算

�?osheep code 对话框的斜杠菜单中可以调整推理级别�?
## 故障排查

### 问题：拉取模型列表失�?
检查：
1. Base URL 是否正确（不要带尾随斜杠�?2. API Key 是否有效
3. 代理是否支持 `/v1/models` 端点

### 问题：流式输出无响应

确认�?1. 代理支持 Server-Sent Events (SSE)
2. 代理返回 `content-type: text/event-stream`
3. 查看浏览器开发者工�?Network 面板确认请求状�?
## 技术实�?
后端 (`backend/src/routes/ai.ts`) 根据 `kind` 决定�?- 请求端点路径
- HTTP 请求头格�?- 响应解析逻辑

所有三种模式共享相同的前端交互层，对用户透明�?