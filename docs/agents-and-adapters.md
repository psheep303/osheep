# Agents, Skills, Templates, And Adapters

## Use Agents Without Lock-In

An Agent block gives a workflow an agent's reasoning and execution ability. Osheep currently ships
with adapters for Codex CLI and Claude Code. Select the adapter's model and permission settings in
the block inspector, then run it inside the selected workspace.

The canvas does not assume that every future agent behaves like either one. It works against an
adapter's declared capabilities: sessions, streaming, approvals, interruption, model selection,
working directory, and usage. That keeps workflows focused on the job rather than one vendor's CLI.

## Skills And Plugins

Use a **Codex skills** or **Claude skills** block to select the skills enabled for the next agent
step. Manage personal skills in **Settings**; a local folder containing `SKILL.md` can be imported.

Use the matching plugin block to choose which discovered plugins are enabled for an agent step.
Selections apply to the underlying CLI configuration, so use only plugins and skills you trust.

## Templates And The Marketspace

Open **Templates** to start from a built-in or personal workflow. A template opens as a workspace
workflow that you can change freely. Save a finished workflow as a personal template for reuse.

The **Template marketspace** reads the [Osheep template registry](https://github.com/psheep303/osheep-template-registry).
Installing an entry downloads its workflow and README into your local system-template library.
Use [osheep-template](https://github.com/psheep303/osheep-template) as the reference collection
when you want examples or a starting point for a new public template.

Review external template content before running it, especially blocks that can change files, call a
network service, or execute a command.

## Remote MCP

The **MCP** block connects to a Remote MCP server, discovers its tools, and calls a selected tool.
Enter the server URL, optional headers or API key, click **Connect**, then select a tool and provide
JSON arguments. Arguments may use workflow references.

Remote MCP calls act with the credentials and access granted to that server. Treat a tool endpoint
and its template arguments as executable integration configuration.

## What Is An Osheep Adapter?

An **Osheep Adapter** is the small backend boundary between a particular agent or harness and the
workflow runtime. It owns native CLI, HTTP, or SDK details and emits normalized sessions and events.
The workflow runtime sees consistent events such as assistant output, tool start/completion,
approval, waiting, success, and failure.

This is how Osheep can add new agents without adding a bespoke kind of block for every integration.
An adapter states exactly what it supports, so the UI and runtime can remain honest about resume,
permissions, streaming, interruption, and usage.

To add an adapter to the repository, read [Adapter development](adapter-development.md). Current
third-party adapters must be added to the backend's explicit registry; dropping a package into a
workspace does not load executable code.
