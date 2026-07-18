# 🐛 工具步骤白点问题调试指南

## 问题描述
工具步骤（read/write/run）同时显示：
- 状态图标（✓/×/运行中的圆圈）
- 白色小圆点

## 已尝试的修复

### 修复 1: CSS 选择器隐藏
```css
.chat-step--tool .chat-step__icon--text {
  display: none !important;
}
```

### 修复 2: 强制透明背景
```css
.chat-step--tool .chat-step__icon {
  background: transparent !important;
}
```

### 修复 3: 移除伪元素
```css
.chat-step--tool .chat-step__icon--ok::before,
.chat-step--tool .chat-step__icon--err::before,
/* ... */
{
  content: none;
  display: none;
}
```

## 浏览器调试步骤

### 步骤 1: 打开开发者工具
1. 在前端页面按 F12
2. 切换到 Elements/元素 标签

### 步骤 2: 检查工具步骤的 HTML
找到一个有白点的工具步骤，应该类似：
```html
<div class="chat-step chat-step--tool">
  <span class="chat-step__icon chat-step__icon--ok">
    <svg>...</svg>  <!-- 这是 CheckIcon -->
  </span>
  <div class="chat-step__body">...</div>
</div>
```

### 步骤 3: 检查元素的计算样式
选中 `<span class="chat-step__icon chat-step__icon--ok">`，查看：
1. **Computed 标签**: 查看 `background-color` 的实际值
2. **Styles 标签**: 查看哪些 CSS 规则被应用
3. 查找是否有其他规则覆盖了我们的修复

### 步骤 4: 查找白点来源
白点可能来自：
1. `background-color` 不是透明
2. `::before` 或 `::after` 伪元素
3. 内部的子元素
4. 边框被渲染成实心圆

## 可能的原因

### 原因 1: CSS 优先级不够
某个更具体的选择器覆盖了我们的规则。

**解决方案**: 使用更具体的选择器
```css
.chat-msg__timeline .chat-step.chat-step--tool .chat-step__icon {
  background: transparent !important;
}
```

### 原因 2: 白点是 SVG 图标
CheckIcon/CrossIcon 等 SVG 可能有自己的圆形背景。

**检查**: 查看 SVG 元素的内容
**解决方案**: 修改 SVG 组件

### 原因 3: 多个图标同时渲染
可能同时渲染了两个 `<span class="chat-step__icon">`。

**检查**: 在 Elements 中数一下有几个 `.chat-step__icon`
**解决方案**: 修复 React 组件渲染逻辑

### 原因 4: 边框被误认为白点
`chat-step__icon--ok` 等有 1.4px 的边框，可能看起来像白点。

**解决方案**: 调整边框颜色或粗细

## 临时测试方案

在浏览器控制台执行：
```javascript
// 强制隐藏所有工具步骤的图标背景
document.querySelectorAll('.chat-step--tool .chat-step__icon').forEach(el => {
  el.style.background = 'transparent';
  el.style.backgroundColor = 'transparent';
});
```

如果白点消失，说明是背景色问题。
如果白点依然存在，说明是其他元素。

## 下一步调试

### 如果是背景色问题
找到覆盖我们规则的CSS，增加优先级。

### 如果是伪元素问题
检查 `::before` 和 `::after`：
```javascript
window.getComputedStyle(
  document.querySelector('.chat-step--tool .chat-step__icon'),
  '::before'
).content
```

### 如果是多个元素
检查 React 组件是否渲染了多次图标。

## 请提供调试信息

在浏览器控制台运行：
```javascript
const icon = document.querySelector('.chat-step--tool .chat-step__icon');
if (icon) {
  console.log('Classes:', icon.className);
  console.log('Background:', window.getComputedStyle(icon).backgroundColor);
  console.log('Border:', window.getComputedStyle(icon).border);
  console.log('HTML:', icon.outerHTML);
}
```

把输出结果发给我，我可以精确定位问题！

---

**创建时间**: 2026-06-15
**状态**: 调试中
