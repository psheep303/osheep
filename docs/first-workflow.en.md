# Your First Workflow

[简体中文](first-workflow.md) · English

Build a small, reviewable coding loop. It uses whatever built-in agent adapter you have installed.

## 1. Create The Chain

Open **Workflow**, create a workflow, then add and connect these blocks:

```text
Workflow run -> Input -> Agent -> Diff approval -> Markdown
```

Choose Codex or Claude Code for the Agent block. The current adapters are examples, not a limit on
what an Osheep workflow can contain.

## 2. Write The Agent Prompt

In the Agent block, use the Input block value in the prompt:

```text
Implement this task in the current workspace:
{{blocks[2].text}}

Inspect the changed files and explain what you changed.
```

Block numbers are displayed on the canvas. Use an output reference when a later block needs an
earlier result.

## 3. Choose Permissions

Pick a permission or sandbox mode appropriate for the task. Start with the least permission that
lets the task proceed. You can stop a run at any time.

## 4. Run And Review

Enter a task in **Input** and click **Run**. Osheep streams the agent session and records the block
trace. When it reaches **Diff approval**, inspect the proposed changes and approve or reject them.

## 5. Reuse It

Open run details to inspect output, retries, terminal logs, tokens, and cost. Export the report when
you need a record. Once the graph works for you, save it as a template.

For a delivery flow, add **Git commit** after the approval block. For a data flow, replace the Agent
block with HTTP, JSON extract, JavaScript, or Remote MCP blocks.
