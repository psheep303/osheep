# Workflow Drag Stability and Empty Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale workflow polling responses from flashing dragged nodes back to old coordinates and render type-aware standard JSON for every unrun block.

**Architecture:** Add a pure workflow behavior module that owns empty output schemas, inspector output selection, and the stale-refresh predicate. `WorkflowTab` will call those helpers while keeping runtime output and persistence unchanged, and a local revision ref will invalidate polling requests that overlap local mutations.

**Tech Stack:** React 18, TypeScript 5.6, Node 24 built-in test runner, Vite 5

---

## File Map

- Create `frontend/src/workbench/workflow-behavior.ts`: pure empty-output and refresh-eligibility behavior shared by production and tests.
- Create `frontend/src/workbench/workflow-behavior.test.ts`: Node tests for every block kind, output precedence, typed empty values, and stale refresh rejection.
- Modify `frontend/src/workbench/WorkflowTab.tsx`: integrate output rendering and local-revision polling protection.
- Modify `frontend/package.json`: expose the focused workflow behavior test command.

### Task 1: Standard Empty Output

**Files:**
- Create: `frontend/src/workbench/workflow-behavior.test.ts`
- Create: `frontend/src/workbench/workflow-behavior.ts`
- Modify: `frontend/src/workbench/WorkflowTab.tsx:1-48, 154-160, 3125-3130, 3726-3731`
- Modify: `frontend/package.json:6-13`

- [ ] **Step 1: Add the focused test command and failing output tests**

Add this script to `frontend/package.json`:

```json
"test:workflow-behavior": "node --test src/workbench/workflow-behavior.test.ts"
```

Create `frontend/src/workbench/workflow-behavior.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";

async function loadBehavior() {
  return import("./workflow-behavior.ts").catch(() => null);
}

function node(kind: string, providerKind = "codex-cli", config: Record<string, unknown> = {}) {
  return {
    id: `node-${kind}`,
    blockId: 7,
    kind,
    title: kind,
    providerKind,
    model: "default",
    prompt: "",
    config,
    x: 0,
    y: 0,
    status: "idle",
  };
}

test("unrun Claude output keeps known values and typed empty values", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.deepEqual(behavior.emptyBlockOutput(node("agent", "claude-cli") as never), {
    type: "claude",
    status: "",
    text: "",
    CHANGED_FILES: [],
    VERIFICATION: [],
  });
});

test("every workflow kind has a standard empty output", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const expectedTypes = new Map([
    ["agent", "codex"],
    ["trigger", "trigger"],
    ["manual-trigger", "manual-trigger"],
    ["cron", "cron"],
    ["webhook-trigger", "webhook-trigger"],
    ["command", "command"],
    ["web", "web"],
    ["http-request", "http-request"],
    ["set", "set"],
    ["if", "if"],
    ["merge", "merge"],
    ["code", "code"],
    ["loop-items", "loop-items"],
    ["wait", "wait"],
    ["json", "json"],
    ["file-read", "file-read"],
    ["file-write", "file-write"],
    ["markdown", "markdown"],
    ["mcp", "mcp"],
  ]);

  for (const [kind, type] of expectedTypes) {
    const output = behavior.emptyBlockOutput(node(kind) as never);
    assert.equal(output.type, type, `${kind} should expose its concrete output type`);
    assert.equal(output.status, "", `${kind} should have an empty runtime status`);
    assert.deepEqual(output.CHANGED_FILES, [], `${kind} should have an empty file list`);
  }
});

test("empty output values preserve their JSON types", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const command = behavior.emptyBlockOutput(node("command") as never);
  const http = behavior.emptyBlockOutput(node("http-request") as never);
  const merge = behavior.emptyBlockOutput(node("merge", "codex-cli", { mode: "object" }) as never);

  assert.equal(command.stdout, "");
  assert.equal(command.exitCode, null);
  assert.equal(command.truncated, null);
  assert.deepEqual(http.headers, {});
  assert.equal(http.ok, null);
  assert.deepEqual(merge.data, {});
  assert.deepEqual(merge.items, []);
});

test("inspector output prefers real node state before the empty schema", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const base = node("agent", "claude-cli");

  assert.equal(behavior.blockOutputText({ ...base, rawOutput: "raw" } as never), "raw");
  assert.equal(behavior.blockOutputText({ ...base, summary: "summary" } as never), "summary");
  assert.equal(behavior.blockOutputText({ ...base, error: "error" } as never), "error");
  assert.equal(
    behavior.blockOutputText(base as never),
    JSON.stringify(behavior.emptyBlockOutput(base as never), null, 2)
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `frontend`:

```powershell
npm run test:workflow-behavior
```

Expected: FAIL at `workflow behavior module should exist` because `workflow-behavior.ts` does not exist.

- [ ] **Step 3: Implement the pure empty-output module**

Create `frontend/src/workbench/workflow-behavior.ts` with:

```ts
import type { WorkflowNode, WorkflowNodeKind } from "./api";

export type WorkflowBlockOutput = Record<string, unknown>;

function blockId(node: WorkflowNode): number | null {
  return typeof node.blockId === "number" && Number.isInteger(node.blockId) && node.blockId > 0
    ? node.blockId
    : null;
}

function configString(node: WorkflowNode, key: string, fallback = ""): string {
  const value = node.config?.[key];
  return typeof value === "string" ? value : fallback;
}

function configNumber(node: WorkflowNode, key: string, fallback: number): number {
  const value = Number(node.config?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function emptyBlockOutput(node: WorkflowNode): WorkflowBlockOutput {
  const kind: WorkflowNodeKind = node.kind ?? "agent";
  switch (kind) {
    case "agent":
      return {
        type: node.providerKind === "claude-cli" ? "claude" : "codex",
        status: "",
        text: "",
        CHANGED_FILES: [],
        VERIFICATION: [],
      };
    case "trigger":
    case "manual-trigger":
      return { type: kind, status: "", id: blockId(node), text: "", CHANGED_FILES: [] };
    case "cron":
      return {
        type: kind,
        status: "",
        id: blockId(node),
        schedule: configString(node, "cron"),
        text: "",
        CHANGED_FILES: [],
      };
    case "webhook-trigger":
      return {
        type: kind,
        status: "",
        id: blockId(node),
        webhookPath: configString(node, "path"),
        text: "",
        CHANGED_FILES: [],
      };
    case "command":
      return {
        type: kind,
        status: "",
        command: "",
        shell: "",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: null,
        CHANGED_FILES: [],
      };
    case "web":
      return {
        type: kind,
        status: "",
        url: "",
        text: "",
        stderr: "",
        exitCode: null,
        truncated: null,
        CHANGED_FILES: [],
      };
    case "http-request":
      return {
        type: kind,
        status: "",
        ok: null,
        method: configString(node, "method", "GET").toUpperCase(),
        requestedUrl: "",
        statusCode: null,
        statusText: "",
        url: "",
        headers: {},
        body: null,
        text: "",
        truncated: null,
        CHANGED_FILES: [],
      };
    case "set":
      return { type: kind, status: "", data: null, text: "", CHANGED_FILES: [] };
    case "if":
      return {
        type: kind,
        status: "",
        result: null,
        operator: configString(node, "operator", "equals"),
        left: null,
        right: null,
        text: "",
        CHANGED_FILES: [],
      };
    case "merge": {
      const mode = configString(node, "mode", "object") === "array" ? "array" : "object";
      return {
        type: kind,
        status: "",
        mode,
        data: mode === "array" ? [] : {},
        items: [],
        text: "",
        CHANGED_FILES: [],
      };
    }
    case "code":
      return { type: kind, status: "", data: null, text: "", CHANGED_FILES: [] };
    case "loop-items": {
      const mode = configString(node, "mode", "items") === "batches" ? "batches" : "items";
      return {
        type: kind,
        status: "",
        mode,
        batchSize: configNumber(node, "batchSize", 1),
        items: [],
        batches: [],
        data: [],
        count: null,
        text: "",
        CHANGED_FILES: [],
      };
    }
    case "wait":
      return {
        type: kind,
        status: "",
        seconds: configNumber(node, "seconds", 1),
        durationMs: null,
        text: "",
        CHANGED_FILES: [],
      };
    case "json":
      return {
        type: kind,
        status: "",
        path: configString(node, "path"),
        source: null,
        value: null,
        data: null,
        text: "",
        CHANGED_FILES: [],
      };
    case "file-read":
      return {
        type: kind,
        status: "",
        path: "",
        content: "",
        size: null,
        mtime: null,
        CHANGED_FILES: [],
      };
    case "file-write":
      return {
        type: kind,
        status: "",
        path: "",
        bytes: null,
        content: "",
        CHANGED_FILES: [],
      };
    case "markdown":
      return { type: kind, status: "", markdown: "", text: "", CHANGED_FILES: [] };
    case "mcp":
      return {
        type: kind,
        status: "",
        remoteLink: "",
        postUrl: "",
        tool: "",
        arguments: {},
        result: {},
        error: {},
        response: {},
        text: "",
        CHANGED_FILES: [],
      };
  }
}

export function blockOutputText(node: WorkflowNode): string {
  return (
    node.rawOutput ||
    node.summary ||
    node.error ||
    JSON.stringify(emptyBlockOutput(node), null, 2)
  );
}
```

- [ ] **Step 4: Integrate the output helper into the inspector**

In `frontend/src/workbench/WorkflowTab.tsx`, import the helper and shared type:

```ts
import {
  blockOutputText,
  type WorkflowBlockOutput,
} from "./workflow-behavior";
```

Remove the local declaration:

```ts
type WorkflowBlockOutput = Record<string, unknown>;
```

In `WorkflowNodeInspector`, replace the current `bodyText` expression with:

```ts
const bodyText = blockOutputText(node);
```

Render the already-resolved value without a literal fallback:

```tsx
<pre className="workflow-inspector__output">{bodyText}</pre>
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run from `frontend`:

```powershell
npm run test:workflow-behavior
```

Expected: PASS for the four output behavior tests.

- [ ] **Step 6: Commit the empty-output behavior**

```powershell
git add frontend/package.json frontend/src/workbench/workflow-behavior.ts frontend/src/workbench/workflow-behavior.test.ts frontend/src/workbench/WorkflowTab.tsx
git commit -m "fix: show standard output for unrun workflow blocks"
```

### Task 2: Reject Stale Polling Responses During Drag

**Files:**
- Modify: `frontend/src/workbench/workflow-behavior.test.ts`
- Modify: `frontend/src/workbench/workflow-behavior.ts`
- Modify: `frontend/src/workbench/WorkflowTab.tsx:675-747, 815-902`

- [ ] **Step 1: Add failing tests for refresh eligibility**

Append to `frontend/src/workbench/workflow-behavior.test.ts`:

```ts
test("workflow refresh applies only when its local revision is still current", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.equal(typeof behavior.canApplyWorkflowRefresh, "function");

  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 4,
      dragging: false,
      pendingSave: false,
    }),
    true
  );
  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 5,
      dragging: false,
      pendingSave: false,
    }),
    false
  );
});

test("workflow refresh is rejected during a drag or pending save", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.equal(typeof behavior.canApplyWorkflowRefresh, "function");

  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 4,
      dragging: true,
      pendingSave: false,
    }),
    false
  );
  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 4,
      dragging: false,
      pendingSave: true,
    }),
    false
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `frontend`:

```powershell
npm run test:workflow-behavior
```

Expected: FAIL because `canApplyWorkflowRefresh` is `undefined`.

- [ ] **Step 3: Implement the refresh predicate**

Append to `frontend/src/workbench/workflow-behavior.ts`:

```ts
interface WorkflowRefreshState {
  requestedRevision: number;
  currentRevision: number;
  dragging: boolean;
  pendingSave: boolean;
}

export function canApplyWorkflowRefresh(state: WorkflowRefreshState): boolean {
  return (
    state.requestedRevision === state.currentRevision &&
    !state.dragging &&
    !state.pendingSave
  );
}
```

- [ ] **Step 4: Track local revisions and guard polling integration**

Add the production import in `frontend/src/workbench/WorkflowTab.tsx`:

```ts
import {
  blockOutputText,
  canApplyWorkflowRefresh,
  type WorkflowBlockOutput,
} from "./workflow-behavior";
```

Add this ref next to `nodeDragRef`:

```ts
const localRevisionRef = useRef(0);
```

Reset it when the initial workflow snapshot loads:

```ts
localRevisionRef.current = 0;
workflowRef.current = record;
setWorkflow(record);
```

Guard both sides of the polling request:

```ts
const refresh = async () => {
  if (nodeDragRef.current || pendingSaveRef.current) return;
  const requestedRevision = localRevisionRef.current;
  try {
    const record = await apiGetWorkflow(workspaceId, workflowId);
    if (
      cancelled ||
      !canApplyWorkflowRefresh({
        requestedRevision,
        currentRevision: localRevisionRef.current,
        dragging: nodeDragRef.current !== null,
        pendingSave: pendingSaveRef.current !== null,
      })
    ) {
      return;
    }
    const isRunning = workflowIsRunning(record);
    workflowRef.current = record;
    setWorkflow(record);
    setRunning(isRunning);
    if (!isRunning) onWorkflowChanged();
  } catch {
    /* keep the current snapshot while the workspace is changing */
  }
};
```

Increment the ref before every local workflow state assignment in `updateWorkflow`, `restoreHistory`, `commitNow`, and `setLiveNodePatch`:

```ts
localRevisionRef.current += 1;
workflowRef.current = next;
setWorkflow(next);
```

For `commitNow`, where the variable is named `record`, use:

```ts
localRevisionRef.current += 1;
workflowRef.current = record;
setWorkflow(record);
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run from `frontend`:

```powershell
npm run test:workflow-behavior
```

Expected: PASS for all six behavior tests.

- [ ] **Step 6: Commit the drag refresh fix**

```powershell
git add frontend/src/workbench/workflow-behavior.ts frontend/src/workbench/workflow-behavior.test.ts frontend/src/workbench/WorkflowTab.tsx
git commit -m "fix: reject stale workflow refreshes during drag"
```

### Task 3: Full Verification

**Files:**
- Verify: `frontend/src/workbench/workflow-behavior.ts`
- Verify: `frontend/src/workbench/workflow-behavior.test.ts`
- Verify: `frontend/src/workbench/WorkflowTab.tsx`
- Verify: `frontend/package.json`

- [ ] **Step 1: Run all focused frontend regression checks**

Run from `frontend`:

```powershell
npm run test:workflow-behavior
npm run check:workflow-css
npm run check:workflow-left-sidebar
npm run check:agent-navigation
```

Expected: every command exits 0 and reports only passing checks.

- [ ] **Step 2: Run the production build**

Run from `frontend`:

```powershell
npm run build
```

Expected: TypeScript and Vite complete successfully with no errors.

- [ ] **Step 3: Start the development server for manual verification**

Run from `frontend`:

```powershell
npm run dev -- --host 127.0.0.1
```

Expected: Vite prints a local URL. Open a workflow, drag one node continuously for longer than 1.5 seconds, and confirm it never jumps back. Select unrun Claude, command, HTTP, merge, and file blocks and confirm their Output panels contain formatted JSON with typed empty values.

- [ ] **Step 4: Confirm the worktree contains only intended implementation changes**

Run:

```powershell
git status --short
git diff --check
```

Expected: no whitespace errors and no unrelated files.
