import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

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
  initialCwd: string
): ShellGuardResult {
  const rootEscaped = escapePwshSingle(workspacesRoot);
  const cwdEscaped = escapePwshSingle(initialCwd);
  const tmpPath = path.join(tmpDir(), `osheep-pwsh-${randomToken()}.ps1`);
  const script = `
$global:OSHEEP_WORKSPACE_ROOT = '${rootEscaped}'
$env:OSHEEP_WORKSPACE_ROOT = '${rootEscaped}'

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
`;

  fs.writeFileSync(tmpPath, script, "utf-8");
  // -NoExit keeps the interactive shell up after the dot-sourced script runs.
  // Use `& '...'` to call the file; functions inside it run in this scope when
  // they declare `global:` explicitly, which we do.
  const args = [
    ...baseArgs,
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
  initialCwd: string
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
