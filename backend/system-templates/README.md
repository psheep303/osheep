# System workflow templates

Each `tpl_*.json` file in this directory is loaded as a system template.

To add or modify a built-in template during development:

1. Edit an existing JSON file or copy one to a new `tpl_<id>.json` file.
2. Keep template, node and edge IDs in the `tpl_`, `node_` and `edge_` formats used by the examples.
3. Restart the backend, or click Refresh in the Template sidebar after saving.

Set `OSHEEP_SYSTEM_TEMPLATES_ROOT` to load system templates from another directory.

System templates are read-only in the UI. User templates continue to live outside workspaces under `~/.osheep/templates` by default.
