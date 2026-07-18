$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cacheRoot = Join-Path $root '.cache'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
$env:npm_config_cache = Join-Path $cacheRoot 'npm'

Write-Host 'Building osheep backend for desktop development...'
Push-Location (Join-Path $root 'backend')
try { & npm.cmd run build } finally { Pop-Location }

Write-Host 'Building osheep frontend for desktop development...'
Push-Location (Join-Path $root 'frontend')
try { & npm.cmd run build } finally { Pop-Location }
