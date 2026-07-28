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

## Review Fix

- Captured the `npm ci` native process exit code immediately and now throw after `Pop-Location` when it is nonzero; the `finally` block always restores the caller's location.
- Moved the staged bundled-Node `require('node-pty')` smoke test outside the conditional pruning block. Missing `node-pty` now produces a nonzero Node exit and stops packaging.
- Kept pruning conditional on the staged `node-pty` path and `prebuilds/win32-x64` presence, and continued to preserve `node-pty/build`.

### Fix Validation

- Windows PowerShell syntax validation: passed.
- Exact syntax output: `PowerShell syntax validation: passed`.
- `git diff --check`: passed.
- A new full `prepare-release.ps1` run was requested but not executed: the active read-only review constraint explicitly prohibited rerunning it, and the environment denied both invocation attempts before the script started.
- Therefore there is no new smoke or size output for this fix. The most recent completed full-run output remains `node-pty OK` and `Desktop stage ready: 139.1 MB` as recorded above.
- Generated `desktop/stage`: absent after fix validation; no cleanup action was required.
- No Tauri build or Cargo release build was run.

### Fix Concerns

- Runtime behavior of the corrected gates has not been reconfirmed by a fresh full preparation run because of the active read-only constraint. Syntax and control flow were verified, but the prior `139.1 MB` measurement predates this gate-only fix.

## Validation Addendum: Commit 8347474

Implementation validation completed against `83474749158ca79893e21cc00a447b926c21de6d`.

### Commands and Results

1. Syntax validation:

   Command: `powershell.exe -NoProfile -Command '$null = [scriptblock]::Create((Get-Content -Raw "D:\project\osheep\desktop\scripts\prepare-release.ps1")); Write-Output "PowerShell syntax OK"'`

   Result: exit code `0`; exact output: `PowerShell syntax OK`.

2. Full stage preparation:

   Command: `powershell.exe -NoProfile -File "D:\project\osheep\desktop\scripts\prepare-release.ps1"`

   Result: exit code `0`; exact final smoke/size output:

   ```text
   node-pty OK
   Desktop stage ready: 139.1 MB (Node runtime: 85.7 MB)
   ```

3. Stage artifact inspection:

   Command: `powershell.exe -NoProfile -Command '$pty = "D:\project\osheep\desktop\stage\backend\node_modules\node-pty"; "prebuilds=" + ((Get-ChildItem (Join-Path $pty "prebuilds") -Directory).Name -join ","); "build=" + (Test-Path (Join-Path $pty "build")); foreach ($dir in "third_party", "deps", "src") { "$dir=" + (Test-Path (Join-Path $pty $dir)) }; "package-lock=" + (Test-Path "D:\project\osheep\desktop\stage\backend\package-lock.json"); "testJsCount=" + @((Get-ChildItem "D:\project\osheep\desktop\stage\backend\dist" -Recurse -Filter "*.test.js")).Count'`

   Exact output:

   ```text
   prebuilds=win32-x64
   build=True
   third_party=False
   deps=False
   src=False
   package-lock=False
   testJsCount=0
   ```

4. Generated-stage cleanup:

   Command: `powershell.exe -NoProfile -Command '$stage = "D:\project\osheep\desktop\stage"; $desktop = (Resolve-Path "D:\project\osheep\desktop").Path; if (Test-Path $stage) { $resolved = (Resolve-Path $stage).Path; if (-not $resolved.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to remove stage outside desktop directory: $resolved" }; Remove-Item -LiteralPath $resolved -Recurse -Force }; "stageExists=" + (Test-Path $stage)'`

   Result: exit code `0`; exact output: `stageExists=False`.

### Addendum Conclusion

The corrected release-stage smoke gates are runtime-validated. The stage contains only the `win32-x64` prebuild, preserves `node-pty/build`, and excludes all requested artifacts. The measured size remains `139.1 MB`, saving `28.9 MB` from the prior `168 MB`. No Tauri build or Cargo release build was run. No implementation concern remains.
