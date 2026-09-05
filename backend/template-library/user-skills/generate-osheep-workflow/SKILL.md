---
name: generate-osheep-workflow
description: Create or revise importable Osheep workflow JSON files, including block configuration, routing, interaction loops, and osheep-json structured agent handoffs.
---

# Generate Osheep Workflow JSON

Use this skill when the user asks to create, generate, translate, or substantially revise an Osheep workflow. Produce a real workflow JSON file in the current project's `.osheep/workflows` directory unless the user names another destination. Do not merely describe the graph.

An Osheep workflow is an executable graph. Correctness depends on four things at once:

1. The stored workflow and every node/edge satisfy the JSON contract.
2. Dependencies and branch handles express the intended control flow.
3. Templates reference outputs that have already run on that path.
4. Each block's configuration matches its runtime behavior, especially interactive Markdown, agent JSON parsing, selectors, and loops.

Before writing, inspect existing `.osheep/workflows/*.json` when available to preserve project naming, layout, adapter choices, and conventions. Treat old `runs`, `summary`, `rawOutput`, `runDetails`, `waitingForInput`, and `waitingForApproval` values as runtime history, not authoring examples.

## Authoring Procedure

1. Convert the request into a graph: trigger, inputs, work, decisions, human gates, side effects, and final outputs.
2. Choose the smallest set of blocks that implements that graph. Do not add a block merely to make the canvas look busy.
3. Assign unique workflow, node, edge, and positive block IDs. Lay forward flow left-to-right with roughly 260-320 pixels between columns and use separate `y` lanes for branches.
4. Add edges for every required dependency. Add `sourceHandle` only to genuine branching outputs.
5. Add templates only after their producer and route are known. A template that points to a block not executed on the same path will fail the run.
6. For structured agent handoffs, add the matching skill selector, use the `osheep-json` request/response contract below, and enable `parseOutputJson` on the agent.
7. Write clean authoring state: node `status` is `idle`, `runs` is empty, and transient execution fields are absent.
8. Parse the finished JSON and check IDs, references, paths, branches, cycles, adapter compatibility, and side-effect settings.

## Workflow File Contract

The filename must be `.osheep/workflows/<workflow-id>.json`, and the filename stem must equal the top-level `id`.

- Workflow IDs: `wf_` followed by 8-32 lowercase letters or digits.
- Node IDs: `node_` followed by 6-32 lowercase letters or digits.
- Edge IDs: `edge_` followed by 6-32 lowercase letters or digits.
- `createdAt` and `updatedAt`: Unix time in milliseconds. Use the same current value for a new workflow.
- JSON must not contain comments, trailing commas, Markdown fences, or `undefined`.

Canonical new-workflow shape:

```json
{
  "id": "wf_review8a1b2c3d",
  "title": "Review and approve",
  "readme": "Reviews a change, asks for approval, then commits it.",
  "createdAt": 1787600000000,
  "updatedAt": 1787600000000,
  "settings": {
    "unbilled": false,
    "maxRunCost": 0,
    "maxRunDurationSeconds": 0,
    "sounds": {
      "nodeSuccess": false,
      "nodeError": true,
      "waitingForChoice": true,
      "runCompleted": true
    }
  },
  "nodes": [],
  "edges": [],
  "runs": []
}
```

`readme` is user documentation for the workflow, so explain required variables, side effects, credentials, and how human choices affect routing. `unbilled: true` suppresses workflow cost accounting; use it only when the user requests that behavior. A zero cost or duration limit means no limit. Sound flags are optional user experience settings; `waitingForChoice` should normally remain true for interactive workflows.

Do not add `templateBinding` to an ordinary generated workflow. It is reserved for workflows instantiated from Osheep's template library.

### Node Contract

Use this complete authoring shape for each node:

```json
{
  "id": "node_review01",
  "blockId": 3,
  "kind": "agent",
  "title": "Review implementation",
  "providerKind": "codex-cli",
  "adapterId": "codex",
  "model": "default",
  "prompt": "Review {{vars[request]}} and return the requested result.",
  "x": 620,
  "y": 120,
  "status": "idle",
  "config": {}
}
```

- `blockId` is the stable positive integer used by `{{blocks[N]...}}`. Keep it unique; it does not need to equal the node's array index.
- `kind` selects behavior. Use only the kinds documented below.
- `providerKind` remains required by stored workflows. Use `codex-cli` or `claude-cli`.
- `adapterId` is the stable adapter identifier. For built-ins use `codex` with `codex-cli`, or `claude-code` with `claude-cli`. For a custom adapter, use its registered ID and a compatible provider fallback.
- `model: "default"` is portable. Use a specific model only when the user requested it or the existing project configuration proves it is available.
- `prompt` is the main text/config input for agent, command, web, file-read, and Markdown blocks. Kinds with dedicated config usually keep it empty.
- `x` and `y` affect canvas layout, not scheduling.
- New nodes use `status: "idle"`. Omit `summary`, `rawOutput`, `error`, `startedAt`, and `completedAt`.
- `config` contains kind-specific authoring fields. Omit runtime-only `runDetails`, `waitingForInput`, `waitingForApproval`, `tools`, `connectedAt`, `connectionStatus`, and `connectionError` unless preserving an intentionally connected MCP definition.

### Edge Contract and Routing

```json
{
  "id": "edge_reviewok01",
  "from": "node_review01",
  "to": "node_approve01",
  "passSummary": true
}
```

- `from` and `to` must name existing, different nodes.
- An edge is both a dependency and a route. A target waits until its forward dependencies resolve.
- Independent ready nodes may execute in parallel. Add a dependency edge when order matters.
- `passSummary` controls whether an upstream summary is included automatically in an agent's incoming summaries. It does not disable dependency ordering, templates, or local blocks' incoming data. Set it to `false` for noisy or secret-bearing outputs that the agent does not need.
- Use `sourceHandle: "true"` / `"false"` for `if`.
- Use `sourceHandle: "success"` / `"failure"` for `diff-approval` and Markdown `action: "approval"`.
- Do not put source handles on ordinary blocks. A non-branching output has no handle and cannot meaningfully choose among labeled routes.
- A target with several dependencies acts like a join: it waits for all relevant forward predecessors. For mutually exclusive branches, merge the branches downstream or connect each branch directly as appropriate.

Feedback edges create repeated passes. Osheep identifies an edge back to a node on the current graph path as a back edge and reruns the reachable forward subgraph. Every cyclic component must have at least one edge leaving the component; otherwise the planner rejects it as a cycle without an exit. Infinite conversational workflows still require manual stop or a duration/cost limit, and should expose an outside status/output edge so the cycle is not closed.

## Template and Data Syntax

Templates are valid in prompts and most string configuration fields:

```text
{{blocks[3].text}}
{{blocks[3].data.items[0].id}}
{{blocks[3]["result"]["summary"]}}
{{vars[request]}}
{{vars["request"].expected_output}}
```

Rules:

- `blocks[N]` uses `blockId`, not array position.
- Paths support dot properties and bracketed property names or numeric indexes.
- Variable names may be unquoted when simple; quote names containing punctuation or spaces.
- Only `blocks[...]` and `vars[...]` expressions are supported. JavaScript expressions, fallback operators, function calls, and arbitrary `{{name}}` placeholders are invalid.
- A referenced block must have produced output already on the active route. Do not reference a future block or a block skipped by a branch.
- During an active run, `vars[...]` must come from a variable block that has executed in that run. Put the variable node upstream.
- Interpolation into ordinary text stringifies objects as JSON.
- When a field expects a value rather than text, a whole template can preserve the native object, array, number, or boolean. This matters for JSON Extract sources, loop sources, and JavaScript templates.
- In JSON configuration strings such as Set Data and HTTP headers, place a template outside JSON quotes to insert a native JSON value; place it inside quotes to insert escaped text.

Common output properties are `type`, `status`, `text`, and often `data`. Prefer `text` for human/agent prompts and `data` or a specific property for programmatic flow.

## Every Supported Block

The following catalog covers every `WorkflowNodeKind` accepted by Osheep. Some recognized trigger/data kinds may not be shown in every version of the block picker, but their JSON contract is supported by the workflow loader and runner.

### 1. Workflow Run (`trigger`)

Starts the reachable graph when the workflow is run. It has no required config and outputs trigger metadata plus `text: "Workflow run trigger fired."`. Most workflows should have exactly one trigger root. Pair it with variable/input blocks, then fan out to independent work when parallelism is useful.

```json
{ "kind": "trigger", "prompt": "", "config": {} }
```

### 2. Manual Trigger (`manual-trigger`)

Semantically marks a manually started root. It behaves like `trigger` during an explicit run and needs no config. Use it when imported JSON should distinguish manual initiation from schedule/webhook metadata; use ordinary `trigger` for maximum UI portability.

### 3. Schedule / Cron (`cron`)

Carries a cron expression and timezone in trigger output. An explicit workflow run evaluates it as a trigger. Do not promise unattended scheduling unless the target Osheep deployment has a scheduler that invokes workflows.

```json
{
  "kind": "cron",
  "prompt": "",
  "config": { "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai" }
}
```

Use standard five-field cron syntax. `timezone: "local"` is portable to the host; an IANA timezone is clearer when execution time must be stable across machines. Pair with HTTP, agent, report, or notification flows.

### 4. Webhook Trigger (`webhook-trigger`)

Carries intended HTTP `method` and route `path` as trigger metadata. An explicit run treats it as a trigger; actual inbound HTTP registration depends on the host integration. Use uppercase methods and a leading-slash path.

```json
{
  "kind": "webhook-trigger",
  "prompt": "",
  "config": { "method": "POST", "path": "/hooks/review" }
}
```

Pair with JSON Extract/Set to normalize a payload, then IF or an agent. Do not embed credentials in the path.

### 5. Input (`input`)

Pauses the workflow and opens a user text-entry interaction. `config.inputTitle` is the question/title shown to the user. On completion its output includes `value`, `data`, and `text`, all containing the entered string.

```json
{
  "kind": "input",
  "prompt": "",
  "config": { "inputTitle": "Enter the release version" }
}
```

Use Input for a standalone value or decision. Follow it with IF for explicit routing, Variable to name/convert the value, or an agent prompt. For a message displayed with context before collecting a reply, use Markdown with `action: "message"` instead.

### 6. Environment Variable (`variable`)

Defines one or more workflow variables. Despite the UI label, these are workflow-scoped data values, not operating-system environment variables. Later blocks read them through `{{vars[name]}}`. Variables from earlier variable blocks are inherited and later definitions overwrite matching names.

```json
{
  "kind": "variable",
  "prompt": "",
  "config": {
    "variables": [
      { "name": "request", "value": "{\"id\":\"task-001\"}", "type": "json" },
      { "name": "dryRun", "value": "true", "type": "boolean" }
    ]
  }
}
```

Types:

- `text`: preserve the string exactly.
- `json`: require valid JSON and return its native value.
- `number`: require a finite number.
- `boolean`: parse a boolean value.
- `auto`: parse JSON when possible, otherwise keep text.

Names and values may contain templates. Use Variable near the start for user-editable parameters, credentials references, policy flags, and structured TaskRequest objects. Do not put secrets directly in a workflow file when a safer project/provider configuration exists.

### 7. Codex / Claude Code (`agent`)

Runs an Osheep adapter-backed coding agent. It receives the resolved block prompt plus summaries from incoming edges whose `passSummary` is true. Agents can inspect, edit, and verify the project according to their adapter permissions, so prompts should state role, objective, constraints, expected handoff, and whether modification is allowed.

Portable Codex configuration:

```json
{
  "kind": "agent",
  "providerKind": "codex-cli",
  "adapterId": "codex",
  "model": "default",
  "prompt": "Implement the approved change in {{vars[request]}} and report verification.",
  "config": {
    "effort": "medium",
    "retries": 0,
    "retryForever": false,
    "retryDelaySeconds": 1,
    "retryStrategy": "none",
    "retryProviderIds": [],
    "keepRunningOnInterrupt": false,
    "alwaysEnter": false,
    "autoSuccess": true,
    "parseOutputJson": false,
    "codexApproval": "on-request",
    "codexSandbox": "workspace-write"
  }
}
```

Portable Claude configuration uses `providerKind: "claude-cli"`, `adapterId: "claude-code"`, and `claudeMode: "acceptEdits"` instead of the two Codex permission fields.

Important options:

- `effort`: Codex supports `low`, `medium`, `high`, `xhigh`, `max`; Claude supports those plus `ultracode`. Availability can vary by model/provider.
- `retries`: integer 0-5. `retryForever: true` overrides the finite count and is dangerous without a run duration/cost limit.
- `retryDelaySeconds`: 0-86400.
- `retryStrategy`: `none`, `lowest-multiplier`, or `round-robin`. Non-`none` strategies require valid configured `retryProviderIds`; never invent provider IDs.
- `keepRunningOnInterrupt`: lets the underlying terminal continue when Osheep is interrupted. Use only when explicitly desired because it weakens stop semantics.
- `autoSuccess`: automatically finishes when the adapter reports completion. When false, the user may need to mark success manually.
- `alwaysEnter`: sends Enter even when the adapter would not normally require it. Leave false unless fixing a known adapter interaction.
- `parseOutputJson`: parses the agent's entire final output as JSON and stores that native value in the block's `text`. Invalid JSON fails the block. Enable it for `osheep-json` pipelines.
- `sessionId`: optional UUID for a persistent/reused conversation. Omit it for a fresh portable workflow; use a stable valid UUID only when continuity is intentional.
- Codex `codexApproval`: `on-request`, `untrusted`, or `never`; `codexSandbox`: `workspace-write`, `read-only`, or `danger-full-access`.
- Claude `claudeMode`: `manual`, `acceptEdits`, `plan`, `auto`, `dontAsk`, or `bypassPermissions`.

Use `read-only`/`plan` for independent review, and writable modes for implementation. A common high-quality chain is planner/reviewer agent -> Markdown approval -> builder agent -> command checks -> diff approval -> commit.

### 8. Run Command (`command`)

Executes `prompt` as a terminal command in the project root. It returns stdout, stderr, exit code, truncation metadata, and human-readable text. A nonzero exit fails the node unless `config.failover` is true.

```json
{
  "kind": "command",
  "prompt": "npm test",
  "config": { "failover": false }
}
```

Use explicit cross-platform project scripts such as `npm test` instead of shell-specific compound commands when the workflow must run on Windows, Linux, web-hosted backends, and desktop. Pair after an implementation agent; pass its output to a verifier or Markdown report. Never generate destructive commands without the user's explicit request.

### 9. JavaScript Code (`code`)

Runs an async JavaScript function body. `input` is the first incoming block output, `items` is the array of all incoming outputs, and `helpers` exposes `jsonPreview` and `textFromAny`. Return any JSON-compatible value; object returns preserve their fields and receive standard `type`, `status`, `data`, and `text` defaults.

```json
{
  "kind": "code",
  "prompt": "",
  "config": {
    "code": "const passed = items.every(item => item.status === 'success');\nreturn { text: passed ? 'ready' : 'blocked', passed, items };"
  }
}
```

Templates inside code are resolved to native values before execution. Use Code for transformations not expressible with Set, JSON Extract, Merge, or IF. Keep it deterministic and small; it runs with JavaScript execution capability and is not a security boundary.

### 10. Fetch Page Text (`web`)

Fetches the URL in `prompt`, strips script/style/tags, collapses whitespace, and returns up to approximately 20,000 characters in `text`. It is suitable for simple public-page context, not reliable HTML parsing, authenticated browsing, or binary downloads.

```json
{ "kind": "web", "prompt": "https://example.com/docs", "config": { "failover": false } }
```

Pair with an agent summarizer, JSON/Code processing for simple text, or Markdown display. Use HTTP Request when headers, methods, bodies, status codes, or JSON are needed.

### 11. HTTP Request (`http-request`)

Performs GET/POST/PUT/PATCH/DELETE with templated URL, headers JSON, and body. `responseType` is `auto`, `json`, or `text`. The output includes HTTP status, final URL, response headers, `body`, `text`, and truncation state. A valid non-2xx HTTP response has `status: "http-error"` but is still structured output; transport/process failures fail the node.

```json
{
  "kind": "http-request",
  "prompt": "",
  "config": {
    "method": "POST",
    "url": "https://api.example.com/reviews",
    "headers": "{\n  \"accept\": \"application/json\",\n  \"content-type\": \"application/json\"\n}",
    "body": "{\"summary\":{{blocks[4].text}}}",
    "responseType": "json",
    "failover": false
  }
}
```

Headers must resolve to a JSON object. GET/HEAD ignore a body. Responses are clipped around 200,000 characters. Pair with Set to build a payload, JSON Extract to select response fields, IF to inspect status, and Wait plus a feedback route for polling. Keep API keys in a variable/provider secret mechanism rather than literal JSON when possible.

### 12. Remote MCP (`mcp`)

Connects to a public HTTPS Remote MCP server, discovers tools, or calls a selected tool. Authoring config:

```json
{
  "kind": "mcp",
  "prompt": "",
  "config": {
    "remoteLink": "https://mcp.example.com",
    "postUrl": "",
    "headers": "{\n  \"MCP-Protocol-Version\": \"2025-03-26\"\n}",
    "apiKey": "{{vars[mcpApiKey]}}",
    "toolName": "search",
    "arguments": "{\n  \"query\": \"{{vars[query]}}\"\n}",
    "failover": false
  }
}
```

`remoteLink` must use HTTPS, contain no URL credentials, and resolve only to public addresses. `headers` and `arguments` must resolve to JSON objects. `postUrl` is normally discovered and should be omitted/empty in portable authored files. The UI's Connect action can populate runtime `tools` metadata; do not fabricate it.

An MCP node connected into an agent's graph can expose its discovered tools to that agent; Osheep may execute requested tool calls and rerun the agent with results. During a normal whole-workflow pass, the MCP block performs connection/discovery and records the available tools. The selected `toolName` is called by the runner's direct single-node execution path or through the agent tool-call flow, not automatically merely because a discovery node appears in a larger graph. Pair with Variable for arguments, Agent for tool-assisted reasoning, JSON Extract for returned results, and `failover` only when a fallback branch can genuinely proceed.

### 13. Set Data (`set`)

Builds a JSON value from `config.data`. The resolved text must be valid JSON. If it is an object, its properties are also copied onto the block output; the complete value is available as `data`, and `text` is a readable representation.

```json
{
  "kind": "set",
  "prompt": "",
  "config": {
    "data": "{\n  \"request\": {{vars[request]}},\n  \"review\": {{blocks[4].text}}\n}"
  }
}
```

Use Set to create HTTP payloads, normalize several scalar fields, or give a downstream agent one coherent object. Use Merge when combining multiple incoming outputs generically and Code for conditional transformations.

### 14. Condition / IF (`if`)

Evaluates `config.expression` and routes through `true` or `false`. Supported comparisons include equality/inequality, numeric ordering, null/empty checks, and values resolved from block/variable templates by Osheep's condition evaluator. Keep expressions simple and explicit.

```json
{
  "kind": "if",
  "prompt": "",
  "config": { "expression": "{{blocks[5].status}} == \"completed\"" }
}
```

Outgoing edges must use `sourceHandle: "true"` or `"false"`. Pair after Input for user decisions, JSON Extract for API fields, or an `osheep-json` agent response. Do not reference a branch-only block that may not have executed.

### 15. Merge (`merge`)

Combines all incoming outputs. In `object` mode it shallowly assigns each incoming `data` object (or output object) from left to right. In `array` mode it returns an array of each incoming `data` value (or output). It also exposes original `items`.

```json
{ "kind": "merge", "prompt": "", "config": { "mode": "object" } }
```

Use it to join parallel branches before reporting or sending a request. Object mode can overwrite duplicate keys, so use Set/Code when collisions need explicit handling. Merge is a join, not an iterator.

### 16. Loop Items (`loop-items`)

Normalizes a source into items and optionally batches them. If `source` is empty, it uses the first incoming block's `data`; otherwise the source is resolved as a native value. A non-array becomes a single-item array. `mode` is `items` or `batches`; `batchSize` is clamped to 1-1000.

```json
{
  "kind": "loop-items",
  "prompt": "",
  "config": {
    "source": "{{blocks[3].data.records}}",
    "mode": "batches",
    "batchSize": 10
  }
}
```

Its output contains `items`, `batches`, `count`, and `data`. This block prepares collections; it does not by itself execute downstream nodes once per item. Use Code, an agent, or a deliberate feedback graph to consume batches. Do not promise map semantics that the runner does not implement.

### 17. Wait (`wait`)

Sleeps for `config.seconds` (0-86400, decimals allowed) and then succeeds with elapsed duration. The value may be templated in JSON even though the UI presents a numeric control.

```json
{ "kind": "wait", "prompt": "", "config": { "seconds": 5 } }
```

Use Wait between polling HTTP calls, after rate-limited operations, or before retry routes. It is not a scheduler and occupies a running workflow while waiting.

### 18. JSON Extract (`json`)

Parses/selects structured data. If `source` is empty it uses the first incoming output; otherwise a whole template preserves native JSON. If the source is a JSON string, it is parsed when possible. `path` selects a loose dot/bracket path; empty path returns the entire source.

```json
{
  "kind": "json",
  "prompt": "",
  "config": {
    "source": "{{blocks[4].text}}",
    "path": "result.verdict"
  }
}
```

Output includes `source`, `value`, `data`, and `text`. Use it after JSON agents, HTTP, MCP, or Set, then feed the result to IF, Variable, Markdown, or another agent.

### 19. Read File (`file-read`)

Reads the workspace-relative path in `prompt` and returns `content`, `size`, and modification time. Paths are resolved within the project by Osheep's file API.

```json
{ "kind": "file-read", "prompt": "docs/spec.md", "config": { "failover": false } }
```

Pair with Agent for review, JSON Extract for a JSON file, or Markdown for preview. Prefer project-relative portable paths; do not generate host-specific absolute paths.

### 20. Write File (`file-write`)

Writes templated `config.content` to templated `config.path`, creating parent directories as needed, and returns path, byte count, and content.

```json
{
  "kind": "file-write",
  "prompt": "",
  "config": {
    "path": "reports/review.md",
    "content": "# Review\n\n{{blocks[4].text}}",
    "failover": false
  }
}
```

Use after an agent or Set/Code formatter to persist artifacts. It is a side effect: make the path obvious in the workflow readme and avoid overwriting important files unless requested. For code changes, prefer an Agent block because it can inspect context and verify edits.

### 21. Diff Approval (`diff-approval`)

Requires a Git repository, opens Osheep's diff review UI, and pauses until the user approves or rejects. It has no authoring config. Approved output routes through `success`; rejected output routes through `failure`.

```json
{ "kind": "diff-approval", "prompt": "", "config": {} }
```

Place it after file-writing/implementation work and before Commit, Push, PR, or other irreversible progression. Connect the failure route to a Markdown explanation, Input, or repair agent. Unlike Markdown approval, it specifically displays the repository diff.

### 22. Commit (`git-commit`)

Requires a Git repository and non-empty templated `message`. With `stageAll: true`, stages all changes before committing; otherwise it commits only already-staged changes. It returns the new HEAD.

```json
{
  "kind": "git-commit",
  "prompt": "",
  "config": { "message": "feat: {{vars[summary]}}", "stageAll": false }
}
```

Normally pair after Diff Approval. Default to `stageAll: false` unless the user explicitly wants the workflow to stage everything, because unrelated workspace changes may exist.

### 23. Switch Branch (`git-checkout`)

Checks out `config.branch`; with `createIfMissing: true`, creates it when absent. It requires a Git repository and returns branch/created metadata.

```json
{
  "kind": "git-checkout",
  "prompt": "",
  "config": { "branch": "feature/{{vars[slug]}}", "createIfMissing": true }
}
```

Place before editing agents. Branch switching can fail with dirty conflicting changes, so explain the precondition in the workflow readme. Never assume a branch name exists unless creation is intended.

### 24. Delete Branch (`git-delete-branch`)

Deletes a local branch, or a branch on `remoteName` when `remote: true`. `force: true` permits force deletion. All fields may be templated.

```json
{
  "kind": "git-delete-branch",
  "prompt": "",
  "config": {
    "branch": "{{vars[branch]}}",
    "force": false,
    "remote": false,
    "remoteName": "origin"
  }
}
```

This is destructive. Generate it only when the user explicitly requests branch cleanup, and place a human approval/decision before it. Avoid `force: true` by default.

### 25. Pull Request (`github-pr`)

Uses repository/GitHub tooling to optionally push the current branch and create a PR. `title` is required in practice; `body`, `base`, and `compare` may be empty to use tool defaults. `draft` creates a draft PR. `push` defaults to true and may establish upstream on the current branch.

```json
{
  "kind": "github-pr",
  "prompt": "",
  "config": {
    "title": "{{vars[prTitle]}}",
    "body": "{{blocks[6].text}}",
    "base": "main",
    "compare": "",
    "draft": true,
    "push": true
  }
}
```

Pair after checks, diff approval, and usually Commit. It requires an authenticated GitHub CLI/repository environment. Creating/pushing a PR is an external side effect; make it explicit and gate it when the request does not already authorize automatic publication.

### 26. Codex Plugins (`codex-plugin`)

Sets the complete enabled Codex plugin selection to `config.pluginSelectors`. Selected discovered plugins are enabled and all other discovered Codex plugins are disabled.

```json
{
  "kind": "codex-plugin",
  "prompt": "",
  "config": { "pluginSelectors": ["owner/plugin"] }
}
```

Use immediately before a Codex agent that needs those plugins. Selectors are installation-specific; inspect existing workflow/settings data and never invent them. Because the operation replaces the enabled set, include every plugin that must remain enabled.

### 27. Claude Plugins (`claude-plugin`)

Sets the complete enabled selection among installed Claude plugins via `config.pluginSelectors`; other installed plugins are disabled. The same replacement and portability cautions as Codex Plugins apply. Pair directly before a Claude Code agent.

### 28. Codex Skills (`codex-skill`)

Moves the named Codex skills from Osheep's `user` group to Enabled and moves all other enabled Codex skills back to `user`. It installs or deletes nothing.

```json
{
  "kind": "codex-skill",
  "prompt": "",
  "config": { "skillNames": ["osheep-json"] }
}
```

Place it before the Codex agent that needs the skills. Since selection replaces the complete enabled set, include all skills that agent must retain. Names must already exist in user/enabled storage.

### 29. Claude Skills (`claude-skill`)

The Claude equivalent of Codex Skills. It applies `config.skillNames` to Claude's complete enabled set and should precede the Claude agent. Use `osheep-json` for strict structured task nodes.

### 30. Markdown Render (`markdown`)

Resolves `prompt` as Markdown and displays the rendered result. It has three materially different modes selected by `config.action`:

#### Display only

```json
{
  "kind": "markdown",
  "prompt": "## Result\n\n{{blocks[4].text}}",
  "config": { "action": "none", "autoSeeResult": true }
}
```

The block succeeds immediately with `markdown` and `text` equal to the rendered source. Use it for final reports, previews, instructions, or intermediate visibility. `autoSeeResult: true` automatically opens the result view; false leaves it available through See Result.

#### Approval

```json
{
  "kind": "markdown",
  "prompt": "## Proposed plan\n\n{{blocks[3].text}}",
  "config": { "action": "approval", "autoSeeResult": true }
}
```

The block renders context, pauses for Approve/Reject, and routes through `success` or `failure`. Use it for plan/spec/release approval when the user needs to judge rendered prose. Use Diff Approval instead when the decision must inspect actual Git changes. Do not author `waitingForApproval`; Osheep sets it at runtime.

#### Message

```json
{
  "kind": "markdown",
  "prompt": "{{blocks[3].text}}",
  "config": { "action": "message", "autoSeeResult": true }
}
```

The block renders the agent's message, pauses for a user reply, then outputs that reply as `message` and `text`. This is the right block for conversational turns, clarification with context, and repair feedback. Do not author `waitingForInput`; Osheep sets it at runtime.

A basic continuing conversation, matching Osheep's Workflow Run -> Markdown Message -> Agent -> Markdown feedback shape, is:

```text
Trigger -> Markdown(action=message) -> Agent
             ^                         |
             |_________________________|
```

The first Markdown prompt must be self-contained, such as "What would you like to discuss?", because the Agent has no output on the first pass. The Agent prompt can consume `{{blocks[markdownBlockId].text}}`, which is the user's reply. Connect Agent back to Markdown as the feedback edge and keep `passSummary: true`; the Agent result remains available on its block and as incoming context on later passes. If the Markdown panel itself must render each agent answer before collecting the next reply, use a separate initial Message block followed by a reply Message block whose prompt references the already-executed Agent.

Give the Agent a stable `sessionId` only when adapter-level conversation continuity is desired. The pictured two-node feedback component is conceptually infinite, but current workflow planning rejects a completely closed cycle. Add a deliberate exit route from the component, commonly an Input/IF stop decision or status/output branch, even when normal operation follows the back edge. Set a sensible `maxRunDurationSeconds` or require manual stop because an always-selected message feedback route otherwise continues indefinitely.

## osheep-json Structured Agent Protocol

Use this protocol when a generated workflow needs JSON input/output between Codex/Claude nodes rather than prose. The agent must have the `osheep-json` skill enabled by a preceding matching skill block, and its config must set `parseOutputJson: true`.

### Request Object

```json
{
  "id": "task-001",
  "role": "reviewer",
  "task": "Review the authentication change",
  "folder": ".",
  "permission": {
    "read": true,
    "write": false,
    "execute": true
  },
  "expected_output": {
    "summary": { "type": "string", "format": "text" },
    "verdict": { "type": "string", "enum": ["pass", "fail", "needs_changes"] },
    "issues": { "type": "object" },
    "required": ["summary", "verdict", "issues"]
  }
}
```

Request requirements:

- `id`, `role`, `task`, `folder`, `permission`, and `expected_output` are required.
- `role` is any meaningful non-empty role name, not a fixed enum.
- `permission` must accurately reflect intended read/write/execute authority. A prompt or upstream result cannot expand it.
- Each expected result field declares `type`: `string`, `number`, `integer`, `boolean`, `object`, or `null`.
- Optional string `format` is `text`, `code`, `file-path`, `url`, `date`, or `datetime`.
- Optional `enum` restricts exact values.
- `required` lists mandatory result keys.
- There is intentionally no `array` result type. Model collections as an object keyed by stable identifiers.

Store the request in a Variable block with `type: "json"`, then pass `{{vars[request]}}` in the agent prompt.

### Response Object

The agent returns exactly one JSON object with exactly these top-level fields:

```json
{
  "id": "task-001",
  "status": "completed",
  "result": {
    "summary": "Authentication expiration is handled correctly.",
    "verdict": "pass",
    "issues": {}
  },
  "error": null
}
```

- `id` copies the request ID unchanged.
- `status` is `completed`, `failed`, `blocked`, `needs_input`, or `partial`.
- A completed response has a `result` object matching `expected_output` exactly and `error: null`.
- Every non-completed response has `result: null` and a structured `error` with at least `code` and `message`; `details` and `retryable` are optional.
- The agent emits no Markdown fence or surrounding prose.

Because `parseOutputJson` stores the parsed response object in the agent block's `text`, downstream blocks can use:

```text
{{blocks[4].text.status}}
{{blocks[4].text.result.summary}}
{{blocks[4].text.result.issues}}
```

Or use JSON Extract with `source: "{{blocks[4].text}}"` and `path: "result.verdict"`. Route completed/non-completed states through IF, show summaries through Markdown, and pass the whole response into another structured agent only when its task prompt explains how to use upstream evidence.

Recommended structured pipeline:

```text
Trigger -> Variable(TaskRequest JSON) -> Codex/Claude Skills(osheep-json)
        -> Agent(parseOutputJson=true) -> JSON Extract(status/verdict)
        -> IF -> Markdown approval/report or next structured Agent
```

Do not confuse workflow file JSON with `osheep-json`: the former describes the graph; the latter is the task protocol carried through agent nodes inside that graph.

## Composition Patterns

### Human-approved implementation

```text
Trigger -> Variable(requirement) -> Planner Agent(read-only)
        -> Markdown approval
success -> Builder Agent(workspace-write) -> Command tests
        -> Diff Approval
success -> Commit -> Markdown result
failure -> Markdown/Input feedback -> Builder feedback edge
```

Use Markdown approval for the proposed plan and Diff Approval for actual changes. Keep Commit after approval and default `stageAll` to false.

### Parallel review and join

```text
Trigger -> Variable
        -> Security Agent ----|
        -> Test Agent --------|-> Merge(array) -> Final Agent -> Markdown
        -> Docs Agent --------|
```

All reviewers can run in parallel. Merge waits for their forward dependencies. Give each role a distinct expected output so the final agent can reconcile evidence rather than repeat work.

### API polling

```text
Trigger -> HTTP start -> JSON Extract(job id) -> Wait -> HTTP status -> JSON Extract(state) -> IF
IF false -> Wait feedback edge
IF true  -> Markdown result
```

The cycle has a true exit. Set a run duration limit, and use failover only if the workflow can meaningfully report a transport failure.

### Structured multi-agent handoff

Use a skill selector before each agent family, set `parseOutputJson: true`, and give every node its own request ID/role/output contract. Use JSON Extract or exact nested templates rather than asking downstream agents to scrape prose.

## Final Validation Checklist

Before finishing:

1. Parse the file as JSON.
2. Confirm the filename stem equals top-level `id` and all IDs match their required patterns.
3. Confirm node IDs, edge IDs, and positive `blockId` values are unique.
4. Confirm every edge endpoint exists and every branch handle matches its source block.
5. Confirm every template uses a real `blockId` or upstream variable, valid path syntax, and an execution path that produces the value first.
6. Confirm at least one trigger reaches the intended graph and no closed cycle exists.
7. Confirm all new nodes are idle and `runs` is `[]`; remove runtime history and transient flags.
8. Confirm adapters/models/plugin selectors/skill names are known or portable defaults, never invented local IDs.
9. Confirm commands and file paths are portable where required and destructive/external side effects are explicitly requested or gated.
10. Confirm structured agents have the correct `osheep-json` selector, request contract, `parseOutputJson: true`, and downstream native-object paths.
11. Confirm the workflow readme explains required input, credentials, human interactions, stop conditions, and side effects.
12. Report the created file path and summarize the graph; do not claim to have run the workflow unless it was actually executed.
