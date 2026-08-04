# Task 13 Report: Frontend Code Splitting and Vendor Chunks

## Status

Implemented Task 13 on `feat/optimization-0.2` against base `e80cd72`.

The frontend now lazy-loads the requested active heavy views and isolates Monaco, xterm, and Markdown dependencies into named Vite chunks. Suspense fallbacks remain inside the side-panel/editor/bottom-panel content containers so loading a view does not replace the workbench shell.

`ChatTab.tsx` exists but has no import or render site in either base `e80cd72` or the current branch, so there was no parent component where it could be converted to `React.lazy` without introducing a new, unused route.

## Implementation

### React lazy loading

- `frontend/src/workbench/Workbench.tsx`
  - Converted `WorkflowTab`, `GitView`, `EditorPane`, and `DiffPane` to named-export `lazy()` imports.
  - Preserved `GotoTarget` as `import type` from `EditorPane`.
  - Added stable, full-size Suspense fallbacks inside the side-panel, editor host, and bottom-panel containers.
  - Existing Task 13 working-tree changes also defer other view-level components reached from these containers.
- `frontend/src/workbench/AgentSettingsView.tsx`
  - Converted `AiSettingsView` to a named-export `lazy()` import.
  - Added a Suspense boundary inside `agent-settings__body`.
- `frontend/src/workbench/workbench.css`
  - Added the required `.tab-loading-fallback` rule at the end of the stylesheet.
- `frontend/src/workbench/TerminalSession.tsx`
  - Preserved the existing deferred-mount cleanup guard used by the lazy terminal path so a Strict Mode effect cleanup cannot leave a blank xterm surface.

### Vite chunking

`frontend/vite.config.ts` now configures:

- `chunkSizeWarningLimit: 1200`
- `monaco-editor` -> `monaco`
- `@xterm` -> `xterm`
- `marked` / `dompurify` -> `markdown`

The existing `npm run build` flow and `scripts/compress-dist.mjs` post-build compression remain unchanged.

## Verification

All requested frontend gates passed:

- Typecheck: `./node_modules/.bin/tsc -p tsconfig.json --noEmit`
- Lint: `npm run lint` (51 files checked)
- Production build: `npm run build`
- Frontend tests:
  - `npm run test:workflow-behavior` (8/8 passed)
  - `npm run test:terminal-conversation` (1/1 passed)
- Guard scripts:
  - `npm run check:agent-navigation`
  - `npm run check:workflow-left-sidebar`
  - `npm run check:workflow-css`
- Source hygiene: `git diff --check`

Desktop was not built or launched, per the task constraint.

## Bundle Metrics

Both builds used the same current dependency installation. The baseline was exported from commit `e80cd72` into a temporary directory and built independently.

| Metric | Base `e80cd72` | Task 13 | Change |
| --- | ---: | ---: | ---: |
| Entry JS | 4,108.38 kB | 217.39 kB | -3,890.99 kB (-94.7%) |
| Entry gzip | 1,077.15 kB | 67.11 kB | -1,010.04 kB (-93.8%) |

The measured base is larger than the 773 kB estimate in the brief, but the final entry is below the requested 300 kB target.

Final production JavaScript chunks include:

| Chunk | Size |
| --- | ---: |
| `monaco-C-EoI3sn.js` | 3,937.59 kB |
| `xterm-AXT4tBbJ.js` | 291.45 kB |
| `index-Cw4gUgD9.js` | 218.09 kB (217.39 kB Vite display) |
| `WorkflowTab-C9vtTgzt.js` | 89.06 kB |
| `markdown-CdA5ezDB.js` | 67.79 kB |
| `GitView-DP5UMwmU.js` | 22.92 kB |
| `AiSettingsView-DoN6ORe4.js` | 15.71 kB |
| `EditorPane-CPAnzFTF.js` | 1.76 kB |
| `DiffPane-Ca_yfNT8.js` | 0.81 kB |

Monaco language workers are also emitted independently (`editor.worker`, `json.worker`, `html.worker`, `css.worker`, and `ts.worker`). Vite still reports the expected warning that the 3.94 MB Monaco vendor chunk exceeds the configured 1,200 kB warning threshold; this is isolated from the application entry and does not fail the build.

## Browser Smoke

A frontend-only Vite dev server was exercised with headless Chromium. No desktop build was performed.

Passed:

- Initial workbench shell rendered with no console errors.
- All seven ActivityBar destinations rendered after navigation: Workflow, Templates, Explorer, Search, Source Control, Claude Code, and Codex.
- Settings rendered.
- An existing workspace loaded successfully.
- Explorer populated and opening `README.md` rendered the lazy Monaco editor.
- Git view rendered with repository status/history.
- No failed JavaScript module requests occurred during successful navigation/editor smoke.

Limitations:

- A Git diff attempt selected an untracked fixture entry; the backend returned HTTP 500 before creating a diff tab, so an end-to-end visible `DiffPane` assertion was not available. The production chunk exists and loaded module/build validation passed.
- Terminal end-to-end smoke requires opening/resuming local agent session metadata. Accessing that view in automation was not authorized, so terminal runtime smoke was not performed. The xterm chunk exists and the terminal conversation tests passed.
- `ChatTab` cannot be smoke-tested because it has no active render route in this branch.

Browser screenshots were captured under `.superpowers/sdd/` for the shell, workspace, and editor smoke runs.

## P1 Review Fix: Cold Monaco Loading

Fixed the review finding that `id.includes("monaco-editor")` also classified `@monaco-editor/react`. That mixed the React wrapper with the 3.94 MB local Monaco package and caused the production entry to statically import and preload Monaco on a cold workbench load.

`frontend/vite.config.ts` now:

- normalizes Rollup module IDs to `/` separators;
- assigns only `/node_modules/monaco-editor/` to the `monaco` chunk, excluding `/node_modules/@monaco-editor/react/` by package-path construction;
- enables `onlyExplicitManualChunks: true` so Rollup does not pull wrapper dependencies into the manual vendor chunk;
- preserves the existing xterm and Markdown chunk rules.

Exact verification after `npm run build`:

- Entry: `index-YXAUvkIo.js`, 224.97 kB (225,678 bytes), gzip 69.56 kB.
- Before fix at commit `682c661`: `index-Cw4gUgD9.js`, 217.39 kB displayed by Vite (218,094 bytes), gzip 67.11 kB.
- Monaco: `monaco-WDIK9jD_.js`, 3,913.73 kB, gzip 993.93 kB.
- Entry static imports: none; specifically no static `monaco-*` import.
- `dist/index.html`: no Monaco module preload or stylesheet link.
- Entry dependency map retains Monaco only as a dynamic dependency for lazy editor/diff loading.
- `EditorPane-waQnu3gX.js` and `DiffPane-BHQAfFQr.js` reference `monaco-WDIK9jD_.js`, preserving runtime editor loading and local workers.

Production preview browser smoke (`vite preview`, headless Chromium):

- Cold workbench Monaco requests: `[]`.
- Cold shell rendered successfully.
- After selecting the existing `osheep` workspace and opening `README.md`, the browser requested `monaco-WDIK9jD_.js` and `monaco-D6kYW_CN.css`.
- Monaco editor became visible.
- Console/page errors: none.

Post-fix validation passed: frontend typecheck, lint, production build, both frontend test suites (9 tests total), and all three guard scripts. Desktop was not built or launched.
