# Workflow Block Output Contract

Every workflow block writes its output as one JSON object. Downstream block inputs can reference prior output with:

```text
{{blocks[2].name}}
{{blocks[3].CHANGED_FILES[0]}}
```

`blocks[n]` uses the stable block id shown in the upper-left corner of each block. Deleting a block does not renumber existing block ids.

## AI Blocks

Applies to Claude Code CLI and Codex CLI blocks.

```json
{
  "type": "codex",
  "status": "success",
  "text": "User-facing answer.",
  "CHANGED_FILES": [],
  "VERIFICATION": [],
  "NEXT": ["none"]
}
```

`type` is `codex` or `claude`. If the model returns plain text, osheep wraps it into this JSON shape under `text`.

## Trigger Block

```json
{
  "type": "trigger",
  "status": "success",
  "id": 1,
  "text": "Workflow run trigger fired.",
  "CHANGED_FILES": []
}
```

## Input Block

Input blocks have both incoming and outgoing connectors. Their entered text is available under the three common value fields:

```json
{
  "type": "input",
  "status": "success",
  "value": "hello",
  "data": "hello",
  "text": "hello",
  "CHANGED_FILES": []
}
```

## Environment Variable Block

The block exposes each configured entry both as a named value in the workflow and as structured
output. Use `{{variables.name}}` in a later field. Text, JSON, number, and boolean entries retain
their selected value type.

```json
{
  "type": "variable",
  "status": "success",
  "variables": {
    "branch": "feature/docs",
    "dryRun": true
  },
  "data": {
    "branch": "feature/docs",
    "dryRun": true
  },
  "text": "{\"branch\":\"feature/docs\",\"dryRun\":true}"
}
```

## Command Block

```json
{
  "type": "command",
  "status": "success",
  "command": "npm test",
  "shell": "auto",
  "exitCode": 0,
  "signal": null,
  "stdout": "...",
  "stderr": "",
  "truncated": false,
  "CHANGED_FILES": []
}
```

## Network Block

```json
{
  "type": "web",
  "status": "success",
  "url": "https://example.com",
  "text": "Extracted page text.",
  "stderr": "",
  "exitCode": 0,
  "truncated": false,
  "CHANGED_FILES": []
}
```

## File Read Block

```json
{
  "type": "file-read",
  "status": "success",
  "path": "README.md",
  "content": "...",
  "size": 1234,
  "mtime": 1760000000000,
  "CHANGED_FILES": []
}
```

## File Write Block

The editor exposes `path` and `content` as separate fields.

```json
{
  "type": "file-write",
  "status": "success",
  "path": "notes.txt",
  "bytes": 12,
  "content": "hello world\n",
  "CHANGED_FILES": ["notes.txt"]
}
```

## Control And Git Blocks

`if` returns `result` and routes execution through its `true` or `false` handle. `diff-approval`
and Markdown approval return `approved`; their `success` and `failure` handles represent approval
and rejection. Markdown message returns the submitted `message`.

```json
{
  "type": "diff-approval",
  "status": "approved",
  "approved": true,
  "text": "Diff approved."
}
```

Git blocks return the useful identifier for the action: `git-commit` returns `head`,
`git-checkout` and `git-delete-branch` return `branch`, and `github-pr` returns `url` and `number`.

## Data Blocks

`set` returns its parsed JSON as `data`. `merge` returns `mode`, `items`, and `data`. `json` returns
`source`, `path`, `value`, and `data`. `loop-items` returns `items`, `batches`, `data`, and `count`.
The JavaScript block returns an object merged into the output, or stores a primitive in `data` and
`text`.

When an Agent block has **Parse output JSON** enabled and returns one JSON object, its properties
are exposed beside the normalized Agent fields. Plain text is always available as `text`.

## Markdown Output Block

Markdown blocks render their `markdown` field in the inspector. They are output-only blocks, so they have no outgoing connector.

```json
{
  "type": "markdown",
  "status": "success",
  "markdown": "## Result\n\nHello",
  "text": "## Result\n\nHello",
  "CHANGED_FILES": []
}
```

## MCP Block

MCP blocks store a Remote MCP Link, optional headers/API key, discovered tools, a selected tool name, and JSON arguments. The backend adds default MCP headers, including `MCP-Protocol-Version: 2025-03-26`, unless the node overrides them. Connecting first tries the SSE transport, captures the endpoint event, sends `initialize` and `tools/list`, and caches the returned POST URL plus tool schemas on the node. If the remote returns 405 for SSE, the backend automatically falls back to Streamable HTTP and sends `initialize` / `tools/list` directly to the Remote MCP Link. Running the block sends `tools/call`.

```json
{
  "type": "mcp",
  "status": "success",
  "remoteLink": "https://api.example.com/mcp/sse",
  "postUrl": "https://api.example.com/mcp/messages",
  "tool": "search_issues",
  "arguments": {
    "query": "bug"
  },
  "result": {
    "content": [{ "type": "text", "text": "..." }]
  },
  "text": "...",
  "CHANGED_FILES": []
}
```

## Template Rules

Templates are resolved before a block runs. Invalid syntax, missing blocks, and missing fields stop the block with a descriptive error.

Example:

```json
{
  "name": "sheep"
}
```

Input:

```text
what is {{blocks[2].name}}
```

Resolved input:

```text
what is sheep
```
