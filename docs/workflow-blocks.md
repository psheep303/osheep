# Workflow Blocks

Build a workflow by adding blocks, connecting their handles, and pressing **Run**. A block runs only when it is reachable from a trigger. Independent ready blocks may run in parallel; configure the workspace limit in Settings when a flow needs less concurrency.

Use a block's visible number to pass an earlier output into a later field:

```text
{{blocks[2].text}}
{{blocks[3].data.items[0]}}
```

Use `{{variables.name}}` for a value created by **Environment variable**. Invalid references stop the relevant block with an error. See [the output contract](workflow-block-output.md) for field shapes.

## Start And Input

| Block | Use it for | Key behavior |
| --- | --- | --- |
| Workflow run | Start a flow from the canvas | Main manual trigger. |
| Schedule (Cron) | Document a scheduled intent | It runs when you click **Run**; it does not register a persistent scheduler yet. |
| Webhook trigger | Configure an intended HTTP entry point | It runs when you click **Run**; it does not expose a persistent webhook endpoint yet. |
| Input | Supply task text | Exposes `value`, `data`, and `text`. |
| Environment variable | Define named workflow values | Supports text, JSON, number, and boolean values; reference them as `{{variables.name}}`. |

## Agent And Workspace Blocks

| Block | Use it for | Key behavior |
| --- | --- | --- |
| Agent | Ask an installed Agent / Harness to work in the workspace | Current built-in adapters are Codex CLI and Claude Code. Select model, permission/sandbox, effort, retries, and optional session ID in the inspector. |
| Codex plugins / Claude plugins | Enable selected CLI plugins for the next step | Changes the underlying CLI selection. Enable only trusted plugins. |
| Codex skills / Claude skills | Enable selected skills for the next step | Choose local or enabled skills; manage and import personal skills in Settings. |
| Run command | Run a shell command in the workspace | Output contains command, stdout, stderr, exit code, and signal. |
| Read file / Write file | Read or change a workspace-relative file | Write file overwrites its destination and records it in `CHANGED_FILES`. |

Agent output is available as `text`. Turn on **Parse output JSON** when an agent deliberately returns one JSON object and later blocks need its fields. Agent runs expose live terminal/session details and support configured retries, provider rotation, interruption handling, and cost tracking.

## Control And Review

| Block | Use it for | Key behavior |
| --- | --- | --- |
| Condition (IF) | Branch on an expression | Connect its `true` and `false` handles separately. |
| Diff approval | Review workspace changes before proceeding | Pauses the flow; its `success` handle is approval and `failure` is rejection. Requires a Git repository. |
| Markdown render | Show a final result, message, or approval | Render Markdown normally, or choose a message/approval action to pause for user input or a decision. |
| Wait | Delay a flow | Pauses for the configured seconds. |
| Loop over items | Normalize an array into items or batches | Emits `items`, `batches`, `data`, and `count`. |

## Data And Network

| Block | Use it for | Key behavior |
| --- | --- | --- |
| Fetch page text | Read the visible text from a page | Returns extracted `text`. |
| HTTP request | Call an API | Configure method, URL, JSON headers/body, and JSON/text response handling. |
| JSON extract | Parse data and read a path | Reads a source value and optional path such as `data.items[0].name`. |
| Set data | Create structured JSON | Templates inside JSON are resolved before execution. |
| Merge | Join several incoming outputs | `object` shallow-merges; `array` collects values. |
| JavaScript code | Transform inputs | Receives `input`, `items`, `helpers.jsonPreview`, and `helpers.textFromAny`; return an object or primitive. |
| Remote MCP | Discover and call an MCP tool | Enter server URL and optional auth, click **Connect**, select a tool, then supply JSON arguments. |

Remote MCP uses SSE when available and falls back to Streamable HTTP. Its arguments can use workflow references. Treat the endpoint, credentials, and tool arguments as trusted integration configuration.

## Git

| Block | Use it for | Key behavior |
| --- | --- | --- |
| Switch branch | Check out or create a branch | Enable creation only when the branch may not exist. |
| Delete branch | Delete a local or remote branch | Force and remote deletion are explicit options. |
| Commit | Commit workspace changes | Provide a message; optionally stage all changes first. |
| Pull request | Push and open a GitHub pull request | Can push the current branch, then creates the PR through the available GitHub CLI integration. |

Git blocks require the workspace to be a Git repository. Place **Diff approval** immediately before destructive Git steps when a human checkpoint matters.

## Run Settings And History

Each workflow has settings for per-run cost and duration limits, optional unbilled runs, alert sounds, and run history. Run observability shows block input/output, retries, terminal logs, token usage, and cost; export a run report when you need a portable record.

Save a useful graph as a personal template. The **Template marketspace** reads the [Osheep template registry](https://github.com/psheep303/osheep-template-registry); example public templates live in [osheep-template](https://github.com/psheep303/osheep-template).
