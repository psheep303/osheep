# Task 9 Report: Desktop Stage Pruning

## Status

Completed.

## Changes

- Updated `desktop/scripts/prepare-release.ps1` to prune non-Windows-x64 `node-pty` prebuilds when `prebuilds/win32-x64` is available.
- Removed staged `node-pty/third_party`, `node-pty/deps`, and `node-pty/src` while preserving `node-pty/build`.
- Removed the staged backend lockfile and compiled `*.test.js` files.
- Added a staged `node-pty` load smoke test that captures the Node process exit code immediately and stops packaging on failure.
- Ran the smoke test from the staged backend directory so module resolution targets the staged dependency tree.

## Validation

- Windows PowerShell syntax validation: passed.
- `powershell.exe -NoProfile -File desktop/scripts/prepare-release.ps1`: passed.
- Smoke output: `node-pty OK`.
- Observed stage size: `139.1 MB`.
- Prior stage size: `168 MB`.
- Observed savings: `28.9 MB` (`17.2%`).
- Remaining `node-pty` prebuild directory: `win32-x64` only.
- Preserved `node-pty/build`: yes.
- Removed `node-pty/third_party`, `node-pty/deps`, and `node-pty/src`: yes.
- Removed staged `package-lock.json`: yes.
- Remaining staged `*.test.js` count: `0`.
- `git diff --check`: passed.

## Constraints

No Tauri build or Cargo release build was run. The ignored generated `desktop/stage` directory was removed after validation; no unrelated files were deleted.

## Concerns

None observed. Pruning source directories remains conditional on the Windows x64 prebuild being present, and the retained `build` directory covers local native compilation fallback.
