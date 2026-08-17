import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Produce shell-launch args + temp init file that locks the working directory
 * to `workspacesRoot` for the lifetime of the shell. The temp file is cleaned
 * up on session end (callers must call the returned `cleanup`).
 */
export interface ShellGuardResult {
  args: string[];
  cleanup: () => void;
}

function escapePwshSingle(s: string): string {
  // Inside a PowerShell single-quoted string, the only escape is doubling the
  // single quote.
  return s.replace(/'/g, "''");
}

function escapeBashSingle(s: string): string {
  // Close the single-quoted segment, insert an escaped ', reopen.
  return s.replace(/'/g, "'\\''");
}

function tmpDir(): string {
  return os.tmpdir();
}

function randomToken(): string {
  return randomBytes(6).toString("hex");
}

/**
 * PowerShell init: redefine Set-Location as a global function and re-alias
 * cd / chdir / sl to it. Defined functions in a -Command run at startup
 * persist into the interactive shell when combined with -NoExit.
 */
export function buildPowerShellGuard(
  baseArgs: string[],
  workspacesRoot: string,
  initialCwd: string,
  initialCommand?: string,
): ShellGuardResult {
  const rootEscaped = escapePwshSingle(workspacesRoot);
  const cwdEscaped = escapePwshSingle(initialCwd);
  const tmpPath = path.join(tmpDir(), `osheep-pwsh-${randomToken()}.ps1`);
  const script = `
$global:OSHEEP_WORKSPACE_ROOT = '${rootEscaped}'
$env:OSHEEP_WORKSPACE_ROOT = '${rootEscaped}'

# Force UTF-8 so guard messages (Chinese) reach xterm.js as UTF-8 bytes rather
# than the console's legacy OEM/ANSI codepage (GBK on zh-CN), which otherwise
# round-trips through xterm.js as mojibake.
try { chcp 65001 > $null } catch {}
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

function global:Set-Location {
    [CmdletBinding(DefaultParameterSetName='Path')]
    param(
        [Parameter(Position=0, ParameterSetName='Path')]
        [string]$Path,
        [Parameter(ParameterSetName='LiteralPath', Mandatory=$true)]
        [Alias('PSPath')]
        [string]$LiteralPath,
        [switch]$PassThru,
        [string]$StackName
    )
    $target = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
    if ([string]::IsNullOrEmpty($target)) { return }
    if ($target -eq '~') { $target = $HOME }
    try {
        if ([System.IO.Path]::IsPathRooted($target)) {
            $resolved = [System.IO.Path]::GetFullPath($target)
        } else {
            $current = (Get-Location -PSProvider FileSystem).ProviderPath
            $resolved = [System.IO.Path]::GetFullPath((Join-Path $current $target))
        }
    } catch {
        Write-Host "[osheep] cd: 无法解析路径 '$target'" -ForegroundColor Yellow
        return
    }
    $root = $global:OSHEEP_WORKSPACE_ROOT
    $rootWithSep = $root + [IO.Path]::DirectorySeparatorChar
    $inRoot = $resolved -ieq $root -or $resolved.StartsWith($rootWithSep, [StringComparison]::OrdinalIgnoreCase)
    if (-not $inRoot) {
        Write-Host "[osheep] 拒绝: 目标 '$resolved' 超出 workspaces 根 '$root'" -ForegroundColor Yellow
        return
    }
    Microsoft.PowerShell.Management\\Set-Location -LiteralPath $resolved
}

Set-Alias -Scope Global -Name cd -Value Set-Location -Force -Option AllScope
Set-Alias -Scope Global -Name chdir -Value Set-Location -Force -Option AllScope
Set-Alias -Scope Global -Name sl -Value Set-Location -Force -Option AllScope

Microsoft.PowerShell.Management\\Set-Location -LiteralPath '${cwdEscaped}'
${
  initialCommand
    ? `
${initialCommand}`
    : ""
}
`;

  // PowerShell 5.1 reads BOM-less files using the system ANSI code page, which
  // garbles Chinese on zh-CN. Prepend a UTF-8 BOM so it consistently decodes
  // the script (and our 拒绝 / 无法解析 messages) as UTF-8.
  fs.writeFileSync(tmpPath, `﻿${script}`, "utf-8");
  // -NoExit keeps the interactive shell up after the dot-sourced script runs.
  // Use `& '...'` to call the file; functions inside it run in this scope when
  // they declare `global:` explicitly, which we do.
  const args = [
    ...baseArgs,
    "-ExecutionPolicy",
    "Bypass",
    "-NoExit",
    "-Command",
    `& '${escapePwshSingle(tmpPath)}'`,
  ];
  return {
    args,
    cleanup: () => {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * bash / git-bash init via --rcfile. The temp file sources the user's normal
 * rc if present, then defines the cd() guard.
 *
 * Note: we drop --login (if the base profile had it) because bash ignores
 * --rcfile under --login. The temp rc explicitly sources ~/.bashrc so users
 * still get their usual setup.
 */
export function buildBashGuard(
  baseArgs: string[],
  workspacesRoot: string,
  initialCwd: string,
  initialCommand?: string,
): ShellGuardResult {
  // Normalize Windows-style backslashes to forward slashes so bash builtins
  // (realpath, cd) consume the path natively. Git Bash maps drive letters
  // automatically via cygpath if available; we just pass POSIX-ish form.
  const rootPosix = workspacesRoot.replace(/\\/g, "/");
  const cwdPosix = initialCwd.replace(/\\/g, "/");
  const rootEsc = escapeBashSingle(rootPosix);
  const cwdEsc = escapeBashSingle(cwdPosix);
  const tmpPath = path.join(tmpDir(), `osheep-bash-${randomToken()}.rc`);
  const script = `
# osheep boundary guard — auto-generated. Source any present user rc first.
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" 2>/dev/null; fi

export OSHEEP_WORKSPACE_ROOT='${rootEsc}'

cd () {
    local target="\${1:-$HOME}"
    if [ "$target" = "~" ]; then target="$HOME"; fi
    # Resolve absolute / relative path. realpath -m allows missing tails.
    local resolved
    if [ "\${target#/}" != "$target" ] || [ "\${target:1:2}" = ":/" ] || [ "\${target:1:2}" = ":\\\\" ]; then
        resolved=$(realpath -m -- "$target" 2>/dev/null || echo "$target")
    else
        resolved=$(realpath -m -- "$PWD/$target" 2>/dev/null || echo "$PWD/$target")
    fi
    # Normalize backslashes from Windows-style inputs.
    resolved="\${resolved//\\\\//}"
    local root="$OSHEEP_WORKSPACE_ROOT"
    case "$resolved" in
        "$root"|"$root"/*)
            builtin cd -- "$target"
            ;;
        *)
            echo "[osheep] 拒绝: 目标 '$resolved' 超出 workspaces 根 '$root'" >&2
            return 1
            ;;
    esac
}

builtin cd -- '${cwdEsc}' 2>/dev/null || true
${
  initialCommand
    ? `
${initialCommand}`
    : ""
}
`;
  fs.writeFileSync(tmpPath, script, "utf-8");
  // Drop any --login from baseArgs (would bypass --rcfile) and force -i.
  const filtered = baseArgs.filter((a) => a !== "--login" && a !== "-l");
  const args = [...filtered, "--rcfile", tmpPath, "-i"];
  return {
    args,
    cleanup: () => {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * cmd.exe init via /K. Two temp .cmd files are written:
 *   - osheep-cmd-init-<token>.cmd  : sets chcp + OSHEEP_WORKSPACE_ROOT, installs
 *     doskey macros aliasing `cd` / `chdir` to the helper, then cd's to the
 *     initial workspace.
 *   - osheep-cmd-cd-<token>.cmd    : resolves the target with `pushd`, rejects
 *     it if outside OSHEEP_WORKSPACE_ROOT, otherwise executes `cd /d` for real.
 *
 * Both files are written with a UTF-8 BOM so chcp 65001 + cmd can correctly
 * interpret the embedded Chinese in error messages.
 */
export function buildCmdGuard(
  baseArgs: string[],
  workspacesRoot: string,
  initialCwd: string,
  initialCommand?: string,
): ShellGuardResult {
  const token = randomToken();
  const initPath = path.join(tmpDir(), `osheep-cmd-init-${token}.cmd`);
  const helperPath = path.join(tmpDir(), `osheep-cmd-cd-${token}.cmd`);

  const initScript = [
    "@echo off",
    "chcp 65001 >nul",
    `set "OSHEEP_WORKSPACE_ROOT=${workspacesRoot}"`,
    `doskey cd=call "${helperPath}" $*`,
    `doskey chdir=call "${helperPath}" $*`,
    `cd /d "${initialCwd}"`,
    ...(initialCommand ? [initialCommand] : []),
    "",
  ].join("\r\n");

  // Helper uses delayed expansion and `pushd` to canonicalize the target, then
  // findstr for a case-insensitive prefix check. The final `cd` is executed
  // outside setlocal so it sticks in the parent (calling) cmd shell.
  const helperScript = [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    'if /i "%~1"=="/d" (',
    '  set "_target=%~2"',
    '  set "_useD=1"',
    ") else (",
    '  set "_target=%~1"',
    '  set "_useD=0"',
    ")",
    'if "!_target!"=="" (',
    "  echo !CD!",
    "  endlocal",
    "  exit /b 0",
    ")",
    'if "!_target!"=="~" set "_target=%USERPROFILE%"',
    "",
    'pushd "!_target!" 2>nul',
    "if errorlevel 1 (",
    '  echo [osheep] cd: 无法解析路径 "!_target!" 1>&2',
    "  endlocal",
    "  exit /b 1",
    ")",
    'set "_resolved=!CD!"',
    "popd",
    "",
    'set "_root=%OSHEEP_WORKSPACE_ROOT%"',
    'set "_ok=0"',
    'if /i "!_resolved!"=="!_root!" set "_ok=1"',
    'if "!_ok!"=="0" (',
    // findstr's CRT argv parser eats a single \" — we need a doubled backslash
    // before the closing quote so it survives as a literal trailing `\`.
    '  (echo !_resolved!) | findstr /i /b /c:"!_root!\\\\" >nul',
    '  if not errorlevel 1 set "_ok=1"',
    ")",
    'if "!_ok!"=="0" (',
    '  echo [osheep] 拒绝: 目标 "!_resolved!" 超出 workspaces 根 "!_root!" 1>&2',
    "  endlocal",
    "  exit /b 1",
    ")",
    "",
    'if "!_useD!"=="1" (',
    "  endlocal & cd /d %2",
    ") else (",
    "  endlocal & cd %1",
    ")",
    "exit /b 0",
    "",
  ].join("\r\n");

  // No BOM: cmd's batch parser does NOT skip a UTF-8 BOM, so leaving it in
  // would prepend invisible bytes to the first line and prevent `@echo off`
  // from taking effect — causing every line of the init to be echoed verbatim.
  fs.writeFileSync(initPath, initScript, "utf-8");
  fs.writeFileSync(helperPath, helperScript, "utf-8");

  // `/D` disables the user's AutoRun registry hook so things like a global
  // `chcp 65001` (which prints `Active code page: 65001`) don't pollute the
  // first frame the user sees. `/K` keeps the shell interactive after init.
  const args = [...baseArgs, "/D", "/K", initPath];
  return {
    args,
    cleanup: () => {
      for (const p of [initPath, helperPath]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
