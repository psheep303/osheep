# Workflow Template Token Rendering Design

## Goal

Render every complete `{{blocks[id].field}}` expression inside workflow template inputs and textareas with a distinct token background while preserving native editing behavior.

## Design

Keep the existing native `input` and `textarea` as the only layer that paints text, the caret, selections, and IME composition. Restore the existing mirror layer behind the native control, but make all mirror text transparent. Only `.workflow-template-token` spans paint a rounded background and subtle inset border; their text remains transparent so users never see doubled glyphs.

Move the editor background and border to the `.workflow-template-editor` host. Make the native control and mirror backgrounds transparent and their borders transparent. The host owns the focus ring through `:focus-within`. Both layers retain identical font metrics, padding, wrapping, and dimensions, and existing scroll synchronization keeps token backgrounds aligned with native text.

Mixed text highlights each complete expression independently. For example, `hello {{blocks[2].text}} world` highlights only `{{blocks[2].text}}`. Incomplete expressions such as `{{blocks[2].text` remain plain text. The control does not add an `fx` gutter or alter stored template strings.

## Testing

Update the existing workflow CSS regression check before production changes. It must require a visible mirror, transparent mirror glyphs, transparent native-control background, visible native text, host-owned border/focus ring, transparent token text with a visible background, and identical mirror/control metrics. Run workflow CSS, workflow behavior, agent navigation, and the production build after implementation.

## Scope

This change does not alter template parsing, spacing normalization, template resolution, form values, node execution, or keyboard behavior.
