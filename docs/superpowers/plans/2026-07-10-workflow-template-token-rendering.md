# Workflow Template Token Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show rounded backgrounds behind every complete workflow template expression without replacing native input or textarea editing.

**Architecture:** Reuse the existing synchronized mirror layer and template parser. The mirror paints only token backgrounds with transparent glyphs; the native control remains the sole painter of text, caret, selection, and IME composition.

**Tech Stack:** React 18, TypeScript 5.6, CSS, Node regression scripts, Vite 5

---

### Task 1: Template Overlay Contract

**Files:**
- Modify: `frontend/scripts/check-workflow-node-css.mjs`
- Modify: `frontend/src/workbench/workbench.css`

- [ ] Change the existing mirror assertion so it requires `display: block`, transparent mirror glyphs, transparent mirror/control backgrounds, visible native-control text, a host-owned border/background, and a token background with transparent token glyphs.
- [ ] Run `npm.cmd run check:workflow-css` and verify it fails because the mirror is currently hidden.
- [ ] Add final CSS overrides:

```css
.workflow-template-editor {
  background: rgba(9, 9, 11, 0.72);
  border: 1px solid var(--wf-border);
  border-radius: 6px;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}

.workflow-template-editor:focus-within {
  border-color: rgba(96, 165, 250, 0.7);
  box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.22), 0 0 0 4px rgba(96, 165, 250, 0.08);
}

.workflow-template-editor__mirror {
  display: block;
  background: transparent;
  border-color: transparent;
  color: transparent;
}

.workflow-template-editor .workflow-template-editor__control,
.workflow-template-editor .workflow-template-editor__control:focus {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  color: var(--wf-text-soft);
  -webkit-text-fill-color: currentColor;
}

.workflow-template-token {
  color: transparent;
  background: rgba(82, 82, 91, 0.72);
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(161, 161, 170, 0.24);
}
```

- [ ] Run `npm.cmd run check:workflow-css` and verify it passes.

### Task 2: Full Verification

**Files:**
- Verify: `frontend/src/workbench/WorkflowTab.tsx`
- Verify: `frontend/src/workbench/workbench.css`
- Verify: `frontend/scripts/check-workflow-node-css.mjs`

- [ ] Run `npm.cmd run check:workflow-css`, `npm.cmd run test:workflow-behavior`, `npm.cmd run check:agent-navigation`, and `npm.cmd run build` from `frontend`.
- [ ] Confirm `http://127.0.0.1:5173` returns HTTP 200 and the worktree passes `git diff --check`.
- [ ] Commit the implementation and plan.
