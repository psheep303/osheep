# osheep Code 严重问题修复总结

**修复时间**: 2026-06-14  
**修复者**: Claude Code (Opus 4.8)

---

## ✅ 已修复的问题

### 1. ✅ **CRITICAL**: `acceptedToolThisRound` 导致内容篡改/丢失

**文件**: `frontend/src/workbench/chat-runtime.ts`

**问题**:
当模型在同一轮输出工具调用后，所有后续内容（thought、ask、verify、text）都会被静默丢弃，导致用户看到"内容篡改"和"输出乱了"。

**修复方案**:
- 移除了所有 `if (acceptedToolThisRound) return;` 检查
- 删除了 `acceptedToolThisRound` 变量
- 保留 `toolsThisRound.length > 0` 检查来控制"一轮只执行一个工具"
- **结果**: 工具调用后的所有内容（verify、ask、文本）现在都会正常显示

**修改的代码**:
```typescript
// 之前：丢弃工具后的所有内容
onThought: (id, thoughtText) => {
  if (acceptedToolThisRound) return;  // ❌ 错误
  upsertThought(id, thoughtText, true);
},

// 现在：显示所有内容
onThought: (id, thoughtText) => {
  // Display all content - removed acceptedToolThisRound check
  upsertThought(id, thoughtText, true);
},
```

**影响范围**: 所有对话，特别是模型同时输出工具调用和说明性文字的场景

---

### 2. ✅ **HIGH**: Reasoning Effort 完全无效

**文件**: `backend/src/routes/ai.ts`

**问题**:
用户调整 reasoning effort 从 low → medium → high 完全没有效果，因为后端只发送 `{ type: "adaptive" }`，忽略了 effort 值。

**修复方案**:
- 根据 effort 值映射到不同的 budget_tokens
  - `low`: 4096 tokens
  - `medium`: 16384 tokens
  - `high`: 32768 tokens
- 修改 TypeScript 类型以支持 `type: "enabled" | "adaptive"`
- 发送 `{ type: "enabled", budget_tokens: <budget> }` 而不是只发送 `{ type: "adaptive" }`

**修改的代码**:
```typescript
// 之前：effort 无效
payload.thinking = { type: "adaptive" };  // ❌ 忽略了 effort 值

// 现在：根据 effort 设置 budget
const budgetMap: Record<string, number> = {
  low: 4096,
  medium: 16384,
  high: 32768,
};
const budget = budgetMap[effort] || 16384;

payload.thinking = {
  type: "enabled",
  budget_tokens: budget,
};
```

**影响范围**: 使用 Claude 4 系列模型且调整 reasoning effort 的所有用户

---

### 3. ✅ **MEDIUM-HIGH**: Ask 步骤重复显示

**文件**: `frontend/src/workbench/ChatTab.tsx`

**问题**:
未回答的 Ask 同时出现在：
1. Timeline 中（作为普通 step）
2. 对话框中（AskPromptDialog）
导致用户看到重复的问题，困惑且不美观。

**修复方案**:
在 `StepRow` 渲染逻辑中，如果 Ask 步骤还没有 answer 且不是 streaming 状态，则返回 `null`（不在 timeline 中显示）。只有已回答的 Ask 才会在 timeline 中显示为历史记录。

**修改的代码**:
```typescript
if (step.kind === "ask") {
  // Don't render ask steps in the timeline if they haven't been answered yet
  // (the AskPromptDialog will handle the UI for pending asks)
  if (!step.answer && !streaming) {
    return null;
  }
  // ... 渲染逻辑
}
```

**影响范围**: 所有使用 Ask 功能的对话

---

## 📊 修复统计

| 文件 | 修改行数 | 修改类型 |
|------|---------|---------|
| `frontend/src/workbench/chat-runtime.ts` | ~15 行 | 删除错误的 return 检查 |
| `backend/src/routes/ai.ts` | ~10 行 | 修复 reasoning effort 逻辑和类型 |
| `frontend/src/workbench/ChatTab.tsx` | ~5 行 | 修复 Ask 重复显示 |

**总计**: 3 个文件，~30 行修改

---

## 🔬 验证结果

### Frontend 构建
```
✓ built in 1.76s
```
✅ 构建成功，无错误

### Backend 构建
```
tsc -b
(no output - success)
```
✅ 构建成功，无 TypeScript 错误

---

## 🎯 用户体验改进

### 修复前
- ❌ 工具调用后的说明文字消失 → "前端乱输出，出现篡改"
- ❌ Ask 问题重复显示两次 → 用户困惑
- ❌ Reasoning effort 调整无效 → "思考强度是个摆设"

### 修复后
- ✅ 所有内容正常显示，无篡改
- ✅ Ask 问题只在对话框中显示一次，回答后在 timeline 显示历史
- ✅ Reasoning effort 真实影响思考 token 预算

---

## 🚫 未修复的问题

### CSS/UI 美观性问题
**优先级**: MEDIUM  
**原因**: 需要更详细的设计需求和用户反馈

建议下一步：
1. 收集具体的 UI 问题（哪里丑？哪里不直观？）
2. 创建设计规范
3. 系统性优化 CSS

### 其他潜在问题
建议继续探测：
- Timeline 滚动行为
- 错误提示的清晰度
- 加载状态的视觉反馈
- 快捷键的一致性

---

## 📝 测试建议

### 手动测试场景

1. **测试内容完整性**
   - 发送一个会触发工具调用的请求
   - 检查工具调用后的文字是否正常显示
   - 特别关注 `<verify>` 和解释性文字

2. **测试 Ask 功能**
   - 触发一个 Ask 对话
   - 确认只在对话框中显示（timeline 中不重复）
   - 回答后确认 timeline 中显示历史记录

3. **测试 Reasoning Effort**
   - 使用 Claude 4 模型
   - 分别设置 low / medium / high effort
   - 观察响应时间和思考深度的变化
   - 检查后端日志确认 budget_tokens 被正确发送

### 自动化测试（建议添加）
```typescript
// 测试：工具后的内容不被丢弃
test('should display content after tool call', () => {
  // 模拟工具调用 + verify
  // 断言：verify 内容存在于 pendingSteps
});

// 测试：Ask 不重复
test('should not duplicate pending ask in timeline', () => {
  // 模拟未回答的 ask
  // 断言：timeline 中不渲染，只有 AskPromptDialog
});
```

---

## 🔄 后续行动

1. ✅ 代码已修复并构建成功
2. ⏭️ 启动服务并进行手动测试
3. ⏭️ 收集用户反馈
4. ⏭️ 解决 CSS/UI 美观性问题
5. ⏭️ 添加自动化测试防止回归

---

## 💡 经验教训

1. **分离关注点**: 执行控制（一轮一个工具）和显示控制（显示所有内容）应该分开
2. **类型安全**: TypeScript 类型定义应该反映实际的 API 使用
3. **避免重复渲染**: UI 中同一信息只应有一个权威来源
4. **用户反馈优先**: "前端乱输出"这类模糊反馈需要深入挖掘根本原因

---

**修复完成！** 🎉

所有 P0 和 P1 优先级的问题已解决。建议立即测试验证效果。
