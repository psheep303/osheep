# Workflow Blocks Guide

This document describes every workflow block currently available in osheep.

Related reference:

- `docs/workflow-block-output.md`

## Template Basics

Most block inputs support templates like:

```text
{{blocks[2].text}}
{{blocks[5].result}}
{{blocks[3].data[0]}}
```

`blocks[n]` uses the visible block id shown on the block itself.

If a block or field is missing, the template resolves to an empty string.

## Triggers

### Workflow run

Kind: `trigger`

Use this as the default starting point for a workflow you manually run from the UI.

Output:

```json
{
  "type": "trigger",
  "status": "success",
  "id": 1,
  "text": "Workflow run trigger fired.",
  "CHANGED_FILES": []
}
```

### Manual Trigger

Kind: `manual-trigger`

This is another manual start block. It behaves like `Workflow run`, but is useful when you want a more explicit trigger label in the graph.

Output is similar to `trigger`, with `type: "manual-trigger"`.

### Cron

Kind: `cron`

Fields:

- `cron`: cron expression, for example `0 9 * * 1-5`
- `timezone`: for example `local`

Current behavior:

- The block can be configured now.
- When you click Run in the UI, it evaluates as a trigger for that run.
- It does not yet register a long-lived scheduler by itself.

Example output:

```json
{
  "type": "cron",
  "status": "success",
  "schedule": "0 9 * * 1-5",
  "text": "Cron trigger evaluated for manual run.",
  "CHANGED_FILES": []
}
```

### Webhook Trigger

Kind: `webhook-trigger`

Fields:

- `method`: HTTP method
- `path`: webhook path, for example `/workflow-hook`

Current behavior:

- The block can be configured now.
- When you click Run in the UI, it evaluates as a trigger for that run.
- It does not yet expose a persistent incoming webhook endpoint by itself.

## Command and AI

### Run command

Kind: `command`

Input:

- command line text

Use it for shell commands such as:

```text
npm test
git status
node scripts/build.js
```

Output includes:

- `command`
- `stdout`
- `stderr`
- `exitCode`
- `signal`

### Codex

Kind: `agent` with provider `codex-cli`

Fields:

- `model`
- `retries`
- `auto success`
- prompt

Use it when you want Codex CLI to inspect, edit, or reason inside the project.

The block writes one JSON object. If the model returns plain text, osheep wraps it into JSON under `text`.

### Claude Code

Kind: `agent` with provider `claude-cli`

Same usage pattern as Codex, but routed to Claude Code CLI.

Additional field:

- `Claude permissions`: `acceptEdits` adds `--permission-mode acceptEdits`; `bypassPermissions` adds `--permission-mode bypassPermissions`.

## Network

### Fetch page text

Kind: `web`

Input:

- URL

Use this when you only want the readable text extracted from a webpage.

Example:

```text
https://example.com
```

Output includes:

- `url`
- `text`
- `stderr`
- `exitCode`

### HTTP Request

Kind: `http-request`

Fields:

- `method`
- `url`
- `headers` as JSON
- `body`
- `responseType`: `auto`, `json`, or `text`

Use this for direct API calls.

Example headers:

```json
{
  "accept": "application/json",
  "authorization": "Bearer {{blocks[2].token}}"
}
```

Example output:

```json
{
  "type": "http-request",
  "status": "success",
  "statusCode": 200,
  "headers": {},
  "body": {},
  "text": "...",
  "CHANGED_FILES": []
}
```

## Logic

### IF

Kind: `if`

Fields:

- `left`
- `operator`
- `right`

Supported operators:

- `equals`
- `notEquals`
- `contains`
- `greaterThan`
- `lessThan`
- `exists`
- `isEmpty`

Example:

```text
left: {{blocks[2].status}}
operator: equals
right: success
```

Output includes:

- `result` as boolean
- `left`
- `right`
- `operator`

### Wait

Kind: `wait`

Fields:

- `seconds`

Use it to pause execution for a fixed amount of time.

### Loop Over Items

Kind: `loop-items`

Fields:

- `source`
- `mode`: `items` or `batches`
- `batchSize`

Use it to normalize an upstream array into:

- `items`: the flat item list
- `batches`: grouped arrays when `batchSize > 1`

Example source:

```text
{{blocks[3].data}}
```

Example output:

```json
{
  "type": "loop-items",
  "status": "success",
  "mode": "batches",
  "batchSize": 2,
  "items": [1, 2, 3, 4],
  "batches": [[1, 2], [3, 4]],
  "data": [[1, 2], [3, 4]],
  "count": 4,
  "CHANGED_FILES": []
}
```

## Data

### Set Data

Kind: `set`

Field:

- `data` as JSON

Use it to build structured data for downstream blocks.

Example:

```json
{
  "title": "{{blocks[2].text}}",
  "ok": true
}
```

### Merge

Kind: `merge`

Field:

- `mode`: `object` or `array`

Use it when several upstream blocks flow into one block.

- `object`: shallow-merges object-like outputs
- `array`: collects upstream outputs into an array

### JSON Extract

Kind: `json`

Fields:

- `source`
- `path`

Use it to parse JSON and pull out a nested value.

Example:

```text
source: {{blocks[4].text}}
path: data.items[0].name
```

### Markdown

Kind: `markdown`

Input:

- markdown text

Use it to generate a final formatted markdown output. In the inspector, use `see MPE` to preview it.

This block has no outgoing connector.

## Code

### Code in JavaScript

Kind: `code`

Field:

- `code`

The block executes JavaScript and receives:

- `input`: first upstream block output
- `items`: all upstream block outputs
- `helpers.jsonPreview`
- `helpers.textFromAny`

Example:

```js
return {
  text: input.text || "",
  length: (input.text || "").length
};
```

Return value rules:

- returning an object merges it into the block output
- returning a primitive stores it in `data` and `text`

## File

### Read file

Kind: `file-read`

Input:

- relative file path

Example:

```text
README.md
```

Output includes:

- `path`
- `content`
- `size`
- `mtime`

### Write file

Kind: `file-write`

Fields:

- `path`
- `content`

Use it to write or overwrite a file inside the workspace.

Output includes:

- `path`
- `bytes`
- `content`
- `CHANGED_FILES`

## MCP

### MCP

Kind: `mcp`

Fields:

- `Remote MCP Link`
- `Headers JSON`
- `API Key`
- discovered `Tool`
- `Arguments JSON`

Use this block to connect to a Remote MCP server and then call one of its tools.

Typical flow:

1. Fill in `Remote MCP Link`
2. Optionally add headers or API key
3. Click `Connect`
4. Pick a discovered tool
5. Adjust `Arguments JSON`
6. Run the block

Behavior notes:

- osheep sends `tools/list` during connect
- discovered tools are cached in the node config
- `Arguments JSON` can use templates
- default MCP headers include `MCP-Protocol-Version: 2025-03-26`

## Practical Patterns

### API workflow

`Manual Trigger -> HTTP Request -> JSON Extract -> Markdown`

### Guarded command workflow

`Workflow run -> Run command -> IF -> Codex`

### Data shaping workflow

`HTTP Request -> JSON Extract -> Set Data -> Merge`

### Multi-item workflow

`HTTP Request -> JSON Extract -> Loop Over Items -> Code in JavaScript`
