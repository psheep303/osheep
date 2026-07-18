# Workflow Drag Stability and Empty Output Design

## Goal

Stop workflow nodes from flashing back to stale positions while they are dragged, and show a standard type-aware JSON output for every block before it has run.

## Current Behavior and Root Cause

`WorkflowTab` polls the saved workflow every 1.5 seconds. Node movement updates only the local workflow while the pointer is moving and schedules persistence when the drag finishes. A poll that starts before or during that interval can apply the backend's older node coordinates. The next pointer event reapplies the local drag coordinates, which appears as a brief flash or jump.

The node inspector currently renders `rawOutput`, `summary`, or `error`, then falls back to the literal text `No summary yet.`. It has no representation of the output contract before a block runs.

## Design

### Drag-Safe Refresh

Track a monotonically increasing local workflow revision in a ref. Increment it whenever a local workflow mutation is applied, including every live node movement.

When polling begins, capture the current revision. After the request completes, apply the returned workflow only when all of the following remain true:

- the component is still active;
- the captured revision still equals the current local revision;
- no node drag is active;
- no local save is pending.

This rejects responses that became stale while in flight, including the race where a poll begins immediately before a drag. The next poll after the drag has been saved can apply the backend snapshot normally. Polling itself remains enabled so workflow run status can continue to refresh.

### Standard Empty Output

Add one pure helper, `emptyBlockOutput(node)`, that returns the standard output object for the node's concrete kind. The helper covers every `WorkflowNodeKind` and mirrors the stable fields emitted by the successful runtime path for that block.

Placeholder values follow these rules:

- values fixed by the output contract are preserved, such as `type: "claude"` for a Claude Code block and the block's known numeric id where that field is part of the contract;
- unknown strings use `""`;
- unknown arrays use `[]`;
- unknown objects use `{}`;
- unknown numbers and booleans use `null`;
- configured values are included only when they are already final output values and do not require template resolution or execution;
- dynamic fields returned by arbitrary JavaScript, HTTP bodies, AI responses, or MCP tools are not invented.

For example, an unrun Claude Code block renders:

```json
{
  "type": "claude",
  "status": "",
  "text": "",
  "CHANGED_FILES": [],
  "VERIFICATION": []
}
```

The inspector chooses its content in this order:

1. `rawOutput`
2. `summary`
3. `error`
4. `stringifyBlockOutput(emptyBlockOutput(node))`

The placeholder is presentation-only. It is not assigned to `rawOutput` or `summary`, saved to the backend, exposed as an upstream block result, or used to resolve templates.

## Error and State Handling

Real success, failure, stopped, and partial streaming outputs keep their existing priority and are never replaced by a placeholder. Invalid legacy output text is also preserved because any non-empty `rawOutput`, `summary`, or `error` remains authoritative.

If a poll is rejected as stale, no error is shown; a later interval retries through the existing refresh loop. Save and polling failures retain the current behavior.

## Testing

Extend the repository's frontend workflow regression check before implementation so it fails on the current code. The check will verify:

- stale polling responses are gated by a local revision and active/pending interaction state;
- the inspector no longer contains the `No summary yet.` fallback;
- Claude and Codex use their provider-specific known `type` values;
- representative string, array, object, number, and boolean placeholders use the required empty values;
- every supported workflow node kind has an empty output schema.

Run the frontend regression scripts and production build after the change. Manually verify a drag lasting longer than 1.5 seconds to cover the polling interval and inspect several unrun block types.

## Scope

This change does not alter backend workflow schemas, runtime block output, template resolution, workflow scheduling, or the visual design of nodes and the inspector.
