# Claude 4.8 Thinking API 更新

## 🔄 API 变更

### 旧版本（Claude 4.7 及之前）

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 16384
  }
}
```

### 新版本（Claude 4.8+）

```json
{
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "medium"
  }
}
```

## ⚠️ 错误信息

如果使用旧格式，会收到错误：

```json
{
  "error": {
    "type": "<nil>",
    "message": "\"***.enabled\" is not supported for this model. Use \"***.adaptive\" and \"output_config.effort\" to control thinking behavior."
  }
}
```

## ✅ 正确实现

### toAnthropicPayload 函数更新

```typescript
if (effort && effort !== "off" && modelSupportsReasoning("anthropic", model)) {
  // Claude 4.8+ 使用 adaptive thinking
  payload.thinking = {
    type: "adaptive",  // 不再是 "enabled"
  };

  // 使用 output_config.effort 控制思考强度
  payload.output_config = {
    effort: effort,  // "low" | "medium" | "high"
  };

  payload.max_tokens = Math.max(payload.max_tokens, 8192);
}
```

## 📊 Effort 级别

| Effort Level | 描述 |
|-------------|------|
| `"low"` | 轻度思考 |
| `"medium"` | 中度思考（默认） |
| `"high"` | 深度思考 |
| `"off"` | 不启用思考 |

## 🔑 关键变化

1. **thinking.type**
   - 旧：`"enabled"`
   - 新：`"adaptive"`

2. **思考强度控制**
   - 旧：`thinking.budget_tokens`（手动指定 token 预算）
   - 新：`output_config.effort`（自适应强度）

3. **优势**
   - ✅ 更简单：不需要计算 token 预算
   - ✅ 更智能：模型自适应调整思考深度
   - ✅ 更灵活：根据问题复杂度动态分配

## 📝 完整示例

```typescript
const payload = {
  model: "claude-opus-4-8",
  messages: [
    {
      role: "user",
      content: "Solve this complex problem..."
    }
  ],
  max_tokens: 8192,
  thinking: {
    type: "adaptive"
  },
  output_config: {
    effort: "high"  // 深度思考
  }
};
```

## 🎯 osheep Code 实现状态

✅ 已更新为 Claude 4.8 的新格式
✅ 支持 adaptive thinking
✅ 支持 output_config.effort
✅ 向后兼容（effort=off 不添加 thinking）

## 🔗 相关文档

- Anthropic API 文档：https://docs.anthropic.com/
- Claude 4.8 更新说明
- Thinking 模式详解

---

**更新时间**: 2026-06-15  
**状态**: ✅ 已实现并测试通过
