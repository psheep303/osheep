# Workflow Scrollbars and Icons Design

## Goal

Make all application scrollbars fit the dark theme, remove the visible scrollbar attached to the workflow toolbar, and replace low-detail workflow block icons with consistent VS Code-quality icons while using official Claude and OpenAI brand marks.

## Current Behavior

The global scrollbar rules only target WebKit pseudo-elements. Browsers that use the standard scrollbar properties can therefore render a light native scrollbar. The workflow toolbar also declares `overflow-x: auto`; because its vertical overflow is not constrained and its scrollbar is visible, it can display an unnecessary scrollbar beside the toolbar.

Workflow block icons are hand-authored SVGs with inconsistent visual density. The Activity Bar already contains official Anthropic Claude and OpenAI logo paths, but the workflow blocks use unrelated placeholder symbols.

## Design

### Scrollbars

Declare `color-scheme: dark` on the root document and add standard `scrollbar-color` / `scrollbar-width` rules so Firefox and other standards-based implementations use a dark thumb and track. Keep the WebKit pseudo-element rules for Chromium, using a narrow dark track, a neutral gray thumb, and a slightly lighter hover state.

Scrollable content such as the workflow inspector remains visibly scrollable. The workflow toolbar keeps horizontal overflow available for narrow windows, but its own scrollbar is hidden with both the standard and WebKit mechanisms, and `overflow-y: hidden` prevents the toolbar from creating a vertical scrollbar.

### Workflow Icons

Add Microsoft's `@vscode/codicons` package and load its official stylesheet once from `frontend/src/main.tsx`. Replace ordinary cases in `WorkflowIcon` with a stable mapping from each `WorkflowIconName` to a Codicon class. Nodes, block categories, and block picker items continue to use the same `WorkflowIcon` entry point, so one mapping controls every workflow surface.

Use 18px icons inside the existing stable icon slots. Icons inherit the current muted, hover, selected, and block-accent colors; no decorative icon frames or bitmap scaling are added.

Create `frontend/src/workbench/BrandIcons.tsx` with shared `ClaudeLogo` and `OpenAILogo` components using the official paths already present in `ActivityBar.tsx`. `ActivityBar` and `WorkflowIcon` import these components. Claude Code blocks render `ClaudeLogo`; Codex blocks render `OpenAILogo`. Brand logos remain filled marks rather than Codicon font glyphs.

## Icon Mapping

The mapping uses semantically close Codicons:

- trigger: `debug-start`
- cron and wait: `clock`
- webhook: `radio-tower`
- command: `terminal`
- network and web: `globe`
- HTTP: `cloud`
- set: `symbol-key`
- IF: `git-branch`
- merge: `git-merge`
- code: `code`
- loop: `sync`
- JSON: `json`
- file and read: `file`
- write: `edit`
- output: `output`
- markdown: `markdown`
- MCP: `plug`
- generic AI: `sparkle`

## Testing

Extend the existing workflow CSS regression script before implementation. The test must fail on the current code and then verify:

- standard and WebKit dark scrollbar declarations exist;
- the workflow toolbar hides its scrollbar while retaining horizontal overflow;
- `@vscode/codicons` is loaded once;
- ordinary workflow icons use Codicon classes;
- Claude and OpenAI workflow icons use shared official brand components;
- the former placeholder Claude star and Codex code-bracket paths are absent.

Run the workflow checks, agent navigation checks, focused workflow behavior tests, and the production build. Verify the running application at desktop and narrow widths, checking the inspector scrollbar, toolbar edge, nodes, and block picker.

## Scope

This change does not alter workflow behavior, node layout, toolbar commands, Activity Bar navigation, or the overall dark palette.
