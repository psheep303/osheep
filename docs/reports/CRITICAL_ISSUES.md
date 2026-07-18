# osheep Code 严重用户体验问题修复报告

**发现时间**: 2026-06-14  
**严重程度**: HIGH - 影响核心用户体验

---

## 🔴 已发现的严重问题

### 1. `acceptedToolThisRound` 导致的内容篡改/丢失 🔴🔴🔴

**严重程度**: CRITICAL  
**文件**: `frontend/src/workbench/chat-runtime.ts`

**问题描述**:
当模型在同一轮输出中发出工具调用后，所有后续的内容（thought、ask、verify、text）都会被静默丢弃：

```typescript
// 第 529-564 行
onPlan: (items) => {
  if (acceptedToolThisRound) return;  // ❌ 丢弃！
  upsertTasks(items);
},
onThought: (id, thoughtText) => {
  if (acceptedToolThisRound) return;  // ❌ 丢弃！
  upsertThought(id, thoughtText, true);
},
onAsk: (ask) => {
  if (acceptedToolThisRound) return;  // ❌ 丢弃！
  commitSteps([...]);
},
onVerify: (txt) => {
  if (acceptedToolThisRound) return;  // ❌ 丢弃！
  commitSteps([...]);
},
```

**用户看到的症状**:
1. 模型输出 `<tool>` 后的 `<verify>` 被丢弃 → 看起来任务没有完成
2. 模型输出 `<tool>` 后的 `<ask>` 被丢弃 → 用户永远看不到询问
3. 模型输出的解释性文字消失 → "前端乱输出，出现篡改"

**为什么这是错误的**:
- `acceptedToolThisRound` 的本意是"一轮只执行一个工具"
- 但它错误地阻止了**显示**后续内容
- 正确做法：阻止**执行**多个工具，但仍应**显示**所有内容

**根本原因**:
混淆了"执行控制"和"显示控制"。文档说"一轮最多一个工具"，但这不意味着要隐藏工具后的文字。

---

### 2. Ask 步骤重复出现且无法响应 🔴🔴

**严重程度**: HIGH  
**位置**: `frontend/src/workbench/ChatTab.tsx` + `chat-runtime.ts`

**问题 A**: Ask 在 timeline 和对话框中重复显示

```typescript
// ChatTab.tsx:340-348 - pendingAsk 逻辑
const pendingAsk = useMemo(() => {
  if (!session || sending) return null;
  const last = session.messages[session.messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  const steps = last.steps ?? [];
  const lastStep = steps[steps.length - 1];
  if (lastStep?.kind === "ask" && !lastStep.answer) return lastStep;
  return null;
}, [session, sending]);
```

**症状**:
1. Ask 在 timeline 中显示（StepRow 渲染）
2. Ask 又在对话框中显示（AskPromptDialog）
3. 用户困惑：为什么同一个问题出现两次？

**问题 B**: 已回答的 ask 仍然触发对话框

当用户回答 ask 后，代码会：
1. 保存 `answer` 到 step (`handleAskAnswer`)
2. 但 `pendingAsk` 仍然匹配到这个 ask
3. 因为检查条件是 `!lastStep.answer`，但保存和检查之间有竞态

---

### 3. Reasoning Effort 完全无效 🔴

**严重程度**: MEDIUM-HIGH  
**文件**: `backend/src/routes/ai.ts`, `chat-runtime.ts`

**问题**:
Reasoning effort 只在特定模型名称下生效，但实际检查逻辑有bug：

```typescript
// backend/src/routes/ai.ts:264-281
function modelSupportsReasoning(kind: ProviderKind, model: string): boolean {
  const m = model.toLowerCase();
  if (kind === "openai") {
    return (
      m.startsWith("gpt-5") ||
      m.startsWith("o1") ||
      m.startsWith("o3") ||
      m.startsWith("o4")
    );
  }
  return (
    m.startsWith("claude-3-7") ||
    m.startsWith("claude-4") ||
    m.startsWith("claude-opus-4") ||
    m.startsWith("claude-sonnet-4") ||
    m.startsWith("claude-haiku-4")
  );
}
```

**Bug**:
1. Claude 4 模型名称是 `claude-opus-4-8`，匹配成功 ✅
2. 但后端第 365-369 行的逻辑已经过时：

```typescript
if (effort && effort !== "off" && modelSupportsReasoning("anthropic", model)) {
  // Claude 4.8+ uses adaptive thinking instead of manual budget
  payload.thinking = { type: "adaptive" };
  payload.max_tokens = Math.max(payload.max_tokens, 8192);
}
```

**问题**:
- 代码注释说"Claude 4.8+ uses adaptive thinking"
- 但实际上不管 effort 是什么值，都只发送 `{ type: "adaptive" }`
- 用户调整 effort 从 low → high 完全没有效果！

---

### 4. 前端 CSS 混乱和视觉问题 🔴

**严重程度**: MEDIUM  
**文件**: `frontend/src/workbench/workbench.css`

**问题**:
根据你的反馈"前端非常丑陋"，需要检查：
1. 颜色对比度是否足够
2. 间距是否合理
3. 动画是否流畅
4. 字体大小是否合适

让我检查 CSS...

---

## 🔧 修复方案

### 修复 1: acceptedToolThisRound 逻辑

**原则**: 工具后的内容应该显示，但不执行

```typescript
// 方案 A: 移除所有 acceptedToolThisRound 检查（最简单）
// 因为工具执行已经有 toolsThisRound.length > 0 的检查

// 方案 B: 只在 onToolCall 中使用（推荐）
onToolCall: (call) => {
  if (toolsThisRound.length > 0) return;  // 只检查这里
  acceptedToolThisRound = true;
  // ...
},
// 其他回调不检查 acceptedToolThisRound
```

### 修复 2: Ask 重复和响应问题

```typescript
// A. 修复 pendingAsk 逻辑
const pendingAsk = useMemo(() => {
  // sending 期间不显示（避免与 pending steps 冲突）
  if (!session || sending) return null;
  
  const last = session.messages[session.messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  
  const steps = last.steps ?? [];
  if (steps.length === 0) return null;
  
  // 只有最后一个 step 是 ask 且没有 answer 时才显示对话框
  const lastStep = steps[steps.length - 1];
  if (lastStep?.kind === "ask" && !lastStep.answer) {
    return lastStep;
  }
  
  return null;
}, [session, sending]);

// B. Timeline 中不渲染未回答的 ask（避免重复）
// 在 MessageBlock 或 StepRow 中过滤
```

### 修复 3: Reasoning Effort

```typescript
// backend/src/routes/ai.ts
// 修改 Anthropic thinking 的实现

if (effort && effort !== "off" && modelSupportsReasoning("anthropic", model)) {
  // 根据 effort 设置不同的 budget
  const budgetMap = {
    low: 4096,
    medium: 16384,
    high: 32768,
  };
  
  payload.thinking = {
    type: "enabled",
    budget_tokens: budgetMap[effort as "low"|"medium"|"high"] || 16384
  };
  payload.max_tokens = Math.max(payload.max_tokens, 8192);
}
```

### 修复 4: UI/UX 改进

需要检查和修复的 CSS 区域：
1. `.chat-step` 的间距和对比度
2. `.ask-dialog` 的视觉层次
3. `.chat-composer` 的视觉反馈
4. 动画的流畅度

---

## 📋 优先级

| 问题 | 严重程度 | 影响范围 | 优先级 |
|------|---------|---------|--------|
| acceptedToolThisRound 内容丢失 | CRITICAL | 所有对话 | P0 - 立即修复 |
| Ask 重复显示 | HIGH | 使用 ask 的对话 | P1 - 本次修复 |
| Reasoning effort 无效 | MEDIUM-HIGH | 使用高级模型的用户 | P1 - 本次修复 |
| UI 丑陋 | MEDIUM | 所有用户 | P2 - 随后优化 |

---

## 🎯 下一步

1. ✅ 已识别问题
2. ⏭️ 立即修复 P0 和 P1 问题
3. ⏭️ 测试修复效果
4. ⏭️ 更新文档

准备开始修复...