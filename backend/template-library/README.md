# Workflow Template Library

English | [简体中文](README.zh-CN.md)

Built-in templates live in `system/<template-id>/template.json`. User templates are stored at
runtime under `backend/.osheep/templates/user`.

## Design Principles

- **Start with runtime, end with Markdown**: each chain starts at Workflow Runtime, continues with
  an Input block, and presents the final result in a Markdown block.
- **Prefer short chains**: do not add extra agents or intermediate steps when one agent can complete
  the task.
- **Choose the right Adapter for the step**: use the best available agent or harness for planning,
  execution, review, or domain-specific work. Current templates use Codex CLI and Claude Code;
  the workflow model is not limited to them.
- **Pass context explicitly**: agent prompts reference required upstream output instead of relying on
  implicit session state.
- **Scale with complexity**: small tasks use one Codex agent; ordinary features use Claude planning
  followed by Codex implementation; only high-risk work adds a review-and-fix loop.

## Built-In Templates

| Template | Use case | Core chain |
| --- | --- | --- |
| Quick coding | Small, well-defined changes | Runtime -> Input -> Codex -> Markdown |
| Code review report | Read-only review and risk checks | Runtime -> Input -> Codex scan -> Claude review -> Markdown |
| Plan then implement | Ordinary feature development | Runtime -> Input -> Claude plan -> Codex implementation -> Markdown |
| Complex feature loop | Cross-module, high-risk features | Runtime -> Input -> Claude plan -> Codex implementation -> Claude review -> Codex fix -> Markdown |
| Difficult bug fix | Unclear cause or hard reproduction | Runtime -> Input -> Codex evidence -> Claude diagnosis -> Codex fix -> Markdown |
| Pre-commit cleanup | Checks and fixes before commit | Runtime -> Input -> Git status -> Claude review -> Codex fix -> diff-check -> Markdown |
| Test completion | Unit, regression, and boundary tests | Runtime -> Input -> Claude test strategy -> Codex tests -> Markdown |
| Documentation-driven development | Implement from public API/framework docs | Runtime -> Input (JSON) -> URL extraction -> Page text -> Claude plan -> Codex implementation -> Markdown |

## Developer Notes

Start Osheep with `bash ./dev.sh --developer` on Linux or `dev-developer.cmd` on Windows to save,
edit, or delete built-in templates. System template changes are synchronized to this directory for
versioning and distribution.

The template locations can be overridden with:

- `OSHEEP_TEMPLATES_ROOT`: runtime template library root.
- `OSHEEP_SYSTEM_TEMPLATES_ROOT`: built-in template source directory.

## Public Template Ecosystem

The [template registry](https://github.com/psheep303/osheep-template-registry) is the marketspace
catalog. Use [osheep-template](https://github.com/psheep303/osheep-template) for public template
examples and contribution structure.
