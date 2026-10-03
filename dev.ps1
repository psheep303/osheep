# osheep one-shot dev launcher (Windows / PowerShell 5.1+)
# Usage:
#   .\dev.ps1              start/restart both
#   .\dev.ps1 -Backend     restart backend only
#   .\dev.ps1 -Frontend    restart frontend only
#   .\dev.ps1 -Developer   start with built-in template authoring enabled

[CmdletBinding()]
param(
  [switch]$Backend,
  [switch]$Frontend,
  [switch]$Developer
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$BackendHost = if ($env:OSHEEP_HOST) { $env:OSHEEP_HOST } else { '127.0.0.1' }
$BackendPort = if ($env:OSHEEP_PORT) { $env:OSHEEP_PORT } else { '4178' }
$FrontendHost = if ($env:OSHEEP_FRONTEND_HOST) { $env:OSHEEP_FRONTEND_HOST } else { $BackendHost }
$FrontendPort = if ($env:OSHEEP_FRONTEND_PORT) { $env:OSHEEP_FRONTEND_PORT } else { '5173' }
$ApiProxy = if ($env:VITE_API_PROXY) { $env:VITE_API_PROXY } else { "http://127.0.0.1:$BackendPort" }

if (-not $Backend -and -not $Frontend) {
  $Backend = $true
  $Frontend = $true
}

function Stop-PortOwner($port) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue
  if (-not $conns) {
    Write-Host "  port $port idle" -ForegroundColor DarkGray
    return
  }
  foreach ($c in $conns) {
    $procId = $c.OwningProcess
    try {
      $p = Get-Process -Id $procId -EA Stop
      Write-Host "  stop $($p.ProcessName) (PID $procId) holding port $port" -ForegroundColor Yellow
      Stop-Process -Id $procId -Force
    } catch {
      Write-Host "  PID $procId already gone" -ForegroundColor DarkGray
    }
  }
  Start-Sleep -Milliseconds 200
}

function Start-DevWindow($title, $workDir, $cmd) {
  $psArgs = @(
    '-NoExit',
    '-NoProfile',
    '-Command',
    "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$workDir'; $cmd"
  )
  Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -WorkingDirectory $workDir | Out-Null
  Write-Host "  spawn $title in $workDir" -ForegroundColor Green
}

$modeLabel = if ($Developer) { 'developer template mode' } else { 'standard mode' }
Write-Host "==> osheep dev launch ($modeLabel)" -ForegroundColor Cyan

if ($Backend) {
  Write-Host "[backend] free port $BackendPort ($BackendHost)" -ForegroundColor Cyan
  Stop-PortOwner ([int]$BackendPort)
  $beDir = $root
  # Keep Rust web development on the same state/workspace roots as the legacy
  # TypeScript backend. This preserves recent projects and workspace-root.json.
  $dataRoot = Join-Path $root 'backend\.osheep'
  $workspacesRoot = Join-Path $root 'backend\workspaces'
  $frontendRoot = Join-Path $root 'frontend\dist'
  $envPrefix = "`$env:OSHEEP_HOST='$BackendHost'; `$env:OSHEEP_PORT='$BackendPort'; `$env:OSHEEP_DATA_ROOT='$dataRoot'; `$env:WORKSPACES_ROOT='$workspacesRoot'; `$env:OSHEEP_FRONTEND_ROOT='$frontendRoot'; `$env:OSHEEP_ALLOW_EXTERNAL_WORKSPACE_PATHS='1'; "
  $beCommand = if ($Developer) { $envPrefix + "`$env:OSHEEP_DEVELOPER_MODE='1'; cargo run -p osheep-server" } else { $envPrefix + 'cargo run -p osheep-server' }
  $beTitle = if ($Developer) { 'osheep-backend [developer]' } else { 'osheep-backend' }
  Start-DevWindow $beTitle $beDir $beCommand
}

if ($Frontend) {
  Write-Host "[frontend] free port $FrontendPort ($FrontendHost)" -ForegroundColor Cyan
  Stop-PortOwner ([int]$FrontendPort)
  $feDir = Join-Path $root 'frontend'
  if (-not (Test-Path (Join-Path $feDir 'node_modules'))) {
    Write-Host "[frontend] node_modules missing, running npm install" -ForegroundColor Yellow
    Push-Location $feDir
    try { npm install } finally { Pop-Location }
  }
  $frontendCommand = "`$env:VITE_API_PROXY='$ApiProxy'; npm run dev -- --host '$FrontendHost' --port $FrontendPort"
  Start-DevWindow 'osheep-frontend' $feDir $frontendCommand
}

Write-Host ""
Write-Host "==> dispatched, two new PowerShell windows should be running" -ForegroundColor Cyan
if ($Backend)  {
  Write-Host "    backend  -> http://${BackendHost}:$BackendPort" -ForegroundColor Gray
  Write-Host "    OSHEEP_HOST=$BackendHost OSHEEP_PORT=$BackendPort" -ForegroundColor DarkGray
  $corsOriginLabel = if ($env:CORS_ORIGIN) { $env:CORS_ORIGIN } else { '<unset>' }
  Write-Host "    CORS_ORIGIN=$corsOriginLabel" -ForegroundColor DarkGray
  Write-Host "    OSHEEP_AUTH_TOKEN=$(if ($env:OSHEEP_AUTH_TOKEN) { '<set>' } else { '<unset>' })" -ForegroundColor DarkGray
}
if ($Frontend) {
  Write-Host "    frontend -> http://${FrontendHost}:$FrontendPort" -ForegroundColor Gray
  Write-Host "    OSHEEP_FRONTEND_HOST=$FrontendHost OSHEEP_FRONTEND_PORT=$FrontendPort" -ForegroundColor DarkGray
  Write-Host "    VITE_API_PROXY=$ApiProxy" -ForegroundColor DarkGray
}
