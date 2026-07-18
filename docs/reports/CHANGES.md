# osheep code 交互优化 (2026-06-10)

## 问题 1：节点顺序混乱 ✅ 已修复

**根因**：自由文本（`pendingText`）被当作独立气泡永远在底部，导致：
- 下方文本还在输出，上方工具节点又更新状态
- 多个节点同时显示"运行中"动画
- 存档后自由文本丢失（只在 `steps.length === 0` 时才渲染 `content`）

**修复方案**：
1. 移除 `TurnView.pendingText` 字段
2. 自由文本作为 `kind:"text"` step 按时间顺序插入 `pendingSteps`
3. 流式追加文本时合并到最后一个 text step（如果存在）
4. `streaming` 标记只给当前最后一个节点
5. 修复 `MessageBlock` 使其始终渲染 `content`（即使有 steps）

**修改文件**：
- `frontend/src/workbench/chat-runtime.ts`
  - 移除 `pendingText` 字段和 `commitText()` 方法
  - 新增 `appendTextStep()` 方法处理自由文本
  - 更新 `collapseFinalText()` 从 steps 中提取文本
- `frontend/src/workbench/ChatTab.tsx`
  - 移除 `PendingAssistant` 的 `text` prop
  - 更新 `isStreamingStep()` 正确标记流式节点
  - 修复 `MessageBlock` 始终渲染 `content`

## 问题 2：自动滚动过于激进 ✅ 已修复

**根因**：`ResizeObserver` 在每次尺寸变化时强制贴底，流式输出持续抖动

**修复方案**（离散滚动 + 严格阈值）：
1. **离散滚动**：仅在新节点出现时跳转一次，单个节点流式增长不滚动
2. **严格贴底判定**：距底部 < 24px 才算贴底（原 8px 改为 24px）
3. 通过 `scrollStateSignature` 检测状态变化触发滚动
4. 使用 `useLayoutEffect` + `requestAnimationFrame` 确保准确定位

**修改文件**：
- `frontend/src/workbench/ChatTab.tsx`
  - 调整 `SCROLL_STICKY_PX` 从 8px → 24px
  - 保持现有 `scrollStateSignature` 机制（已实现离散滚动）
  - `isAtScrollBottom()` 使用严格阈值判定

## 文档更新 🚧 需手动完成

以下文档需要更新（已识别但未修改，因文件被锁定）：
- `.osheep/docs/ai/osheep-code-prompt.md`
  - 第 10 行：移除"调一个或多个工具"中的"或多个"
  - 第 59 行：Rule 3 改为"强制一轮一个工具"（不是"批处理"）
  - 第 107-114 行：更新工具调用节奏说明，强调一次一个工具
  - 第 174 行：移除"合法批处理"相关描述

## 验证清单

- [x] 前端类型检查通过（`npx tsc -p . --noEmit`）
- [x] 前端构建成功（`npm run build`）
- [ ] 手动测试：发起对话，观察节点按顺序出现
- [ ] 手动测试：滚动到中间，新节点出现时不自动滚动
- [ ] 手动测试：滚动到底部，新节点出现时自动跟随
- [ ] 手动测试：流式文本 step 正确累积，不会多个同时活跃
