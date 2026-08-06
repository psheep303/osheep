# Frontend theming

Theme values live at the top of `src/styles.css`. Components should consume CSS custom properties
instead of checking the active theme in React or embedding light/dark color literals.

## Token layers

1. Workbench primitives such as `--bg-editor`, `--fg-default`, `--accent`, and `--surface-2`
   preserve the existing application contract.
2. Component roles prefixed with `--ui-` describe intent: card surfaces, control surfaces, borders,
   selection, links, shadows, and status colors. New component CSS should prefer these roles.
3. Family-specific tokens such as `--provider-icon-*` and `--wf-*` are appropriate when a component
   family needs a palette that is not shared by the rest of the workbench.
4. Inline custom properties may select a value, but visual declarations should remain in CSS. For
   example, provider cards set `--provider-icon-color`; CSS controls how that color is mixed for each
   theme.

## Adding a theme

1. Extend the preference type and setting options in `src/i18n/UiPreferences.tsx` and
   `src/workbench/SettingsView.tsx`.
2. Add a `:root[data-theme="..."]` block after the default theme in `src/styles.css`.
3. Override every `--ui-` role. Override primitives only when the whole workbench needs a different
   value, and override family tokens when their palette needs theme-specific contrast.
4. Add focused overrides for legacy selectors only when they cannot yet consume a semantic token.
5. Run `npm run test:theme`, the full test suite, and the CSS equivalence update when workbench CSS
   changes.

The `forced-colors` block maps component roles to system colors and is the baseline for a future
selectable high-contrast theme.
