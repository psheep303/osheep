# Template library

The runtime library is stored outside workspaces under `~/.osheep/templates`:

```text
system/<template-id>/template.json + icon.*
user/<template-id>/template.json + icon.*
```

The `system/` directory beside this README contains the built-in templates shipped with osheep. Start osheep with `dev-developer.cmd` to expose developer-only template actions. Saving a workflow as built-in, editing a system template workflow, changing its icon, or deleting it updates both the runtime library and this source directory so the result can be committed and distributed.

Set `OSHEEP_TEMPLATES_ROOT` to move the runtime template library and `OSHEEP_SYSTEM_TEMPLATES_ROOT` to move the built-in source directory.
