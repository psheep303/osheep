# Workflow Coder Compact Design

## Goal

Improve the workflow frontend so building and running workflows feels tighter, faster, and more refined for programmers while keeping the current professional workbench flow.

## Chosen Direction

Use the Coder Compact Apple approach:

- A compact dark canvas that feels closer to Xcode, Apple Developer tools, and Linear than to a touch-first consumer app.
- Small, precise toolbar controls sized for mouse and keyboard workflows.
- Compact workflow nodes that read like flow chips, not large cards.
- A right-side inspector and block picker with high information density, restrained borders, and minimal shadow.

## Scope

Change only the workflow frontend surface:

- `frontend/src/workbench/WorkflowTab.tsx`
- `frontend/src/workbench/workbench.css`

No backend workflow execution behavior changes are required. The existing pan, zoom, auto-arrange, minimap, context menus, node inspector, details panel, MPE panel, and block picker should remain available.

## User Experience

The workflow tab should open into a clean developer canvas. The title, save state, add, arrange, fit, undo, redo, zoom, run block, stop, and run workflow controls should be compact and grouped, not large or decorative. Text buttons should be avoided where an icon already communicates the command.

Nodes should stay compact and scannable. They should show block id, icon, title, status, selected state, running state, success state, and error state without expanding into card-heavy layouts. Handles should be small but targetable, with clear hover/connection affordance.

The right-side panels should feel like a dense macOS-style inspector, not a modal blocking the workspace. Form fields, chips, segmented controls, MCP actions, output previews, run details, and markdown preview should share one visual language.

The block picker should make adding a block faster: category rail on the left, block grid on the right, high-contrast icon tiles, and subtle hover motion.

## Visual System

Use a focused programmer-tool palette:

- Base: near-black graphite.
- Surface: solid charcoal.
- Border: low-contrast white strokes.
- Accent: cool blue for primary actions and selected connections.
- Success, warning, and error: restrained green, amber, and red.

Use rounded corners at 5-6px for controls and panels. Avoid heavy blur, large shadows, decorative glow, blobs, or one-note gradients. Use color mostly for state and selection.

## Interaction Requirements

- Preserve pointer panning, wheel zoom, fit view, auto-arrange, minimap navigation, node dragging, edge dragging, and context menus.
- Add clearer toolbar grouping through compact command clusters.
- Preserve accessible button labels and titles.
- Keep layout stable across desktop widths and usable below 900px.
- Do not add visible instructional copy.

## Error Handling

The existing workflow error banner remains. Restyle it to match the Pro Glass system while keeping the same dismiss behavior and message text.

## Testing And Verification

The project currently has no frontend test script beyond build/type checking. Verification will use:

- `npm run build` in `frontend/`

Manual visual inspection should check:

- The workflow page renders without overlapping toolbar controls.
- The right inspector and block picker fit inside the viewport.
- Nodes remain compact and text does not overflow incoherently.
- Selected, running, success, error, hover, disabled, and connection states remain visually distinct.

## Out Of Scope

- Backend workflow execution changes.
- New workflow block types.
- New dependencies.
- Large component extraction outside the workflow surface.
