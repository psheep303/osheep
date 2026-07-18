# Workflow Scrollbars and Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render dark cross-browser scrollbars, hide the workflow toolbar scrollbar, and use official VS Code Codicons plus official Claude/OpenAI marks for workflow blocks.

**Architecture:** Keep `WorkflowIcon` as the single workflow icon entry point, but render Codicon font classes for ordinary blocks and shared React SVG components for brands. Put browser-wide scrollbar behavior in `styles.css` and toolbar-specific overflow behavior in `workbench.css`.

**Tech Stack:** React 18, TypeScript 5.6, CSS, `@vscode/codicons`, Node regression scripts, Vite 5

---

### Task 1: Add Failing Visual Contract Checks

**Files:**
- Modify: `frontend/scripts/check-workflow-node-css.mjs`

- [ ] Add reads for `styles.css`, `package.json`, `ActivityBar.tsx`, and the planned `BrandIcons.tsx` file, allowing the missing brand file to produce an empty string.
- [ ] Add assertions that require `color-scheme: dark`, standard `scrollbar-color`, dark WebKit scrollbar rules, hidden workflow toolbar scrollbars, the Codicons dependency/import, Codicon class mapping in `WorkflowTab.tsx`, shared brand imports, and removal of the placeholder Claude/Codex paths.
- [ ] Run `npm.cmd run check:workflow-css` from `frontend` and confirm it fails because the new contracts are absent.

The new assertions will use these exact contract strings and patterns:

```js
assert(styles.includes("color-scheme: dark"), "root UI must declare a dark native color scheme");
assert(/scrollbar-color:\s*#[0-9a-f]{6}\s+#[0-9a-f]{6}/i.test(styles), "standard scrollbars must use dark colors");
assert(styles.includes("::-webkit-scrollbar-thumb"), "Chromium scrollbar thumb styling must remain available");
assert(/\.workflow-toolbar[\s\S]*overflow-y:\s*hidden/.test(css), "workflow toolbar must not create a vertical scrollbar");
assert(/\.workflow-toolbar::?-webkit-scrollbar|\.workflow-toolbar\s+::-webkit-scrollbar/.test(css), "workflow toolbar scrollbar must be hidden in Chromium");
assert(packageJson.dependencies?.["@vscode/codicons"], "frontend must depend on official VS Code Codicons");
assert(main.includes('@vscode/codicons/dist/codicon.css'), "Codicons stylesheet must load once from main.tsx");
assert(workflowTab.includes("codicon codicon-"), "ordinary workflow icons must render Codicon classes");
assert(activityBar.includes('from "./BrandIcons"') && workflowTab.includes('from "./BrandIcons"'), "ActivityBar and WorkflowTab must share brand icons");
assert(brandIcons.includes("function ClaudeLogo") && brandIcons.includes("function OpenAILogo"), "shared official brand components must exist");
```

### Task 2: Implement Scrollbars and Icons

**Files:**
- Create: `frontend/src/workbench/BrandIcons.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/workbench/workbench.css`
- Modify: `frontend/src/workbench/ActivityBar.tsx`
- Modify: `frontend/src/workbench/WorkflowTab.tsx`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

- [ ] Install the official icon package from `frontend`:

```powershell
npm.cmd install @vscode/codicons
```

- [ ] Move the existing official `ClaudeCodeIcon` and `CodexIcon` SVG implementations from `ActivityBar.tsx` into `BrandIcons.tsx`, rename them `ClaudeLogo` and `OpenAILogo`, export them, and import them from both consumers. Preserve the existing `viewBox`, official path data, fill rules, and current-color behavior unchanged.
- [ ] Import Codicons once in `main.tsx`:

```ts
import "@vscode/codicons/dist/codicon.css";
```

- [ ] Replace ordinary hand-authored cases in `WorkflowIcon` with a typed Codicon mapping and retain dedicated brand cases:

```ts
const WORKFLOW_CODICONS: Partial<Record<WorkflowIconName, string>> = {
  trigger: "debug-start",
  cron: "clock",
  webhook: "radio-tower",
  command: "terminal",
  ai: "sparkle",
  network: "globe",
  web: "globe",
  http: "cloud",
  set: "symbol-key",
  if: "git-branch",
  merge: "git-merge",
  code: "code",
  wait: "clock",
  json: "json",
  loop: "sync",
  file: "file",
  read: "file",
  write: "edit",
  output: "output",
  markdown: "markdown",
  mcp: "plug",
};

function WorkflowIcon({ name }: { name: WorkflowIconName }) {
  if (name === "claude") return <ClaudeLogo />;
  if (name === "codex") return <OpenAILogo />;
  const codicon = WORKFLOW_CODICONS[name] ?? "symbol-misc";
  return <i className={`codicon codicon-${codicon}`} aria-hidden />;
}
```

- [ ] Add standards-based and WebKit dark scrollbar rules in `styles.css`:

```css
:root {
  color-scheme: dark;
  scrollbar-color: #3f3f46 #111113;
  scrollbar-width: thin;
}

::-webkit-scrollbar-track {
  background: #111113;
}

::-webkit-scrollbar-thumb {
  background: #3f3f46;
}

::-webkit-scrollbar-thumb:hover {
  background: #52525b;
}
```

- [ ] Keep toolbar horizontal overflow but hide its scrollbar in `workbench.css`:

```css
.workflow-toolbar {
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.workflow-toolbar::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
```

- [ ] Update icon CSS so both SVG brand marks and Codicon font glyphs occupy the same stable 18px slot and inherit existing colors.
- [ ] Run `npm.cmd run check:workflow-css` and confirm the visual contract passes.
- [ ] Run `npm.cmd run check:agent-navigation` and confirm the Activity Bar still uses the official brands.

### Task 3: Verify and Deliver

**Files:**
- Verify all files from Tasks 1 and 2.

- [ ] Run from `frontend`:

```powershell
npm.cmd run check:workflow-css
npm.cmd run check:workflow-left-sidebar
npm.cmd run check:agent-navigation
npm.cmd run test:workflow-behavior
npm.cmd run build
```

- [ ] Verify `http://127.0.0.1:5173` returns HTTP 200 and `http://127.0.0.1:4178/api/health` returns `{"ok":true}`.
- [ ] Confirm `git diff --check` reports no whitespace errors and commit the implementation.
