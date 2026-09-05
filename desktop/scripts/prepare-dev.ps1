$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cacheRoot = Join-Path $root '.cache'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
$env:npm_config_cache = Join-Path $cacheRoot 'npm'

Copy-Item (Join-Path $root 'frontend\public\osheep-icon.png') (Join-Path $root 'desktop\shell\osheep-icon.png') -Force

Write-Host 'Building shared Rust service for desktop development...'
Push-Location $root
try { & cargo build -p osheep-server --locked } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "cargo build -p osheep-server failed with exit code $LASTEXITCODE" }
$serviceStage = Join-Path $root 'desktop\stage\service'
New-Item -ItemType Directory -Force -Path $serviceStage | Out-Null
Copy-Item (Join-Path $root 'target\debug\osheep-server.exe') (Join-Path $serviceStage 'osheep-server.exe') -Force

Write-Host 'Building osheep frontend for desktop development...'
Push-Location (Join-Path $root 'frontend')
try { & npm.cmd run build } finally { Pop-Location }
