# Workflow Coder Compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle and lightly restructure the workflow frontend into a tighter, programmer-focused Apple-inspired workflow editor.

**Architecture:** Keep the workflow state and execution logic inside `WorkflowTab.tsx`. Add small presentational helpers only where they reduce toolbar markup complexity. Do most visual work in the workflow section of `workbench.css`.

**Tech Stack:** React 18, TypeScript, Vite, CSS, existing inline SVG icons.

---

### Task 1: Compact Command Bar Polish

**Files:**
- Modify: `frontend/src/workbench/WorkflowTab.tsx`
- Modify: `frontend/src/workbench/workbench.css`

- [ ] **Step 1: Verify baseline build**

Run: `npm run build` from `frontend/`

Expected: TypeScript and Vite either pass or reveal pre-existing build errors before styling work begins.

- [ ] **Step 2: Group toolbar controls**

In `WorkflowTab.tsx`, wrap existing toolbar controls into semantic clusters using classes:

```tsx
<div className="workflow-toolbar__cluster workflow-toolbar__cluster--identity">...</div>
<div className="workflow-toolbar__cluster">...</div>
<div className="workflow-toolbar__cluster workflow-toolbar__cluster--run">...</div>
```

Keep every existing button action, title, and aria-label.

- [ ] **Step 3: Style toolbar as compact programmer command bar**

In `workbench.css`, update `.workflow-toolbar`, `.workflow-toolbar__cluster`, `.workflow-toolbar__title-label`, `.workflow-toolbar__status`, `.workflow-toolbar__btn`, and `.workflow-toolbar__zoom` to create a precise, 24px-control command surface.

- [ ] **Step 4: Build check**

Run: `npm run build` from `frontend/`

Expected: exit code 0.

### Task 2: Canvas And Node Visual System

**Files:**
- Modify: `frontend/src/workbench/workbench.css`

- [ ] **Step 1: Update canvas depth**

Restyle `.workflow-tab`, `.workflow-body`, `.workflow-canvas-wrap`, `.workflow-canvas`, `.workflow-edge`, `.workflow-edge.is-muted`, `.workflow-edge.is-draft`, and `#workflow-arrow path` to use a clean graphite background, subtle grid, and refined edge colors.

- [ ] **Step 2: Update node surfaces**

Restyle `.workflow-node`, state variants, `.workflow-node__id`, `.workflow-node__icon`, `.workflow-node__name`, and `.workflow-node__handle` for compact developer flow-chip nodes with distinct selected, running, success, and error states.

- [ ] **Step 3: Check responsive stability**

Review CSS for fixed node dimensions, stable text overflow, and hover states that do not resize the node.

- [ ] **Step 4: Build check**

Run: `npm run build` from `frontend/`

Expected: exit code 0.

### Task 3: Inspector, Details, And Block Picker Polish

**Files:**
- Modify: `frontend/src/workbench/workbench.css`

- [ ] **Step 1: Restyle panel shells**

Update `.workflow-panel-shell`, `.workflow-inspector`, `.workflow-block-picker`, `.workflow-run-details`, `.workflow-mpe-panel`, and `.workflow-rename-panel` so panels feel like dense right-side macOS-style inspectors.

- [ ] **Step 2: Restyle form controls and chips**

Update workflow inspector field, template editor, segmented control, chip, edge row, output, markdown preview, MCP state, and footer button styles.

- [ ] **Step 3: Restyle block picker**

Update category rail and block item tiles with clear icons, compact spacing, and hover/focus states.

- [ ] **Step 4: Build check**

Run: `npm run build` from `frontend/`

Expected: exit code 0.

### Task 4: Final Verification

**Files:**
- Read: `frontend/src/workbench/WorkflowTab.tsx`
- Read: `frontend/src/workbench/workbench.css`

- [ ] **Step 1: Scan changed workflow CSS**

Check that the workflow UI is not dominated by one hue family, does not use decorative blobs, and does not add visible instructional copy.

- [ ] **Step 2: Scan changed TSX**

Check that all existing workflow actions still call the same handlers and all icon buttons keep accessible labels.

- [ ] **Step 3: Final build**

Run: `npm run build` from `frontend/`

Expected: exit code 0.
