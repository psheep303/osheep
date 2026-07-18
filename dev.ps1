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
$BackendPort  = 4178
$FrontendPort = 5173

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
  Write-Host "[backend] free port $BackendPort" -ForegroundColor Cyan
  Stop-PortOwner $BackendPort
  $beDir = Join-Path $root 'backend'
  if (-not (Test-Path (Join-Path $beDir 'node_modules'))) {
    Write-Host "[backend] node_modules missing, running npm install" -ForegroundColor Yellow
    Push-Location $beDir
    try { npm install } finally { Pop-Location }
  }
  $beCommand = if ($Developer) {
    "`$env:OSHEEP_DEVELOPER_MODE='1'; npm run dev"
  } else {
    'npm run dev'
  }
  $beTitle = if ($Developer) { 'osheep-backend [developer]' } else { 'osheep-backend' }
  Start-DevWindow $beTitle $beDir $beCommand
}

if ($Frontend) {
  Write-Host "[frontend] free port $FrontendPort" -ForegroundColor Cyan
  Stop-PortOwner $FrontendPort
  $feDir = Join-Path $root 'frontend'
  if (-not (Test-Path (Join-Path $feDir 'node_modules'))) {
    Write-Host "[frontend] node_modules missing, running npm install" -ForegroundColor Yellow
    Push-Location $feDir
    try { npm install } finally { Pop-Location }
  }
  Start-DevWindow 'osheep-frontend' $feDir 'npm run dev'
}

Write-Host ""
Write-Host "==> dispatched, two new PowerShell windows should be running" -ForegroundColor Cyan
if ($Backend)  { Write-Host "    backend  -> http://127.0.0.1:$BackendPort" -ForegroundColor Gray }
if ($Frontend) { Write-Host "    frontend -> http://127.0.0.1:$FrontendPort" -ForegroundColor Gray }
