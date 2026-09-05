$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$desktop = Join-Path $root 'desktop'
$stage = Join-Path $desktop 'stage'

& (Join-Path $PSScriptRoot 'prepare-dev.ps1')

Write-Host 'Building shared Rust service for desktop release...'
Push-Location $root
try { & cargo build -p osheep-server --release --locked } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "cargo release build failed with exit code $LASTEXITCODE" }

if (Test-Path $stage) {
  $resolvedStage = (Resolve-Path $stage).Path
  if (-not $resolvedStage.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear stage outside desktop directory: $resolvedStage"
  }
  Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $stage 'frontend') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'service') | Out-Null

Copy-Item (Join-Path $root 'frontend\dist\*') (Join-Path $stage 'frontend') -Recurse
Copy-Item (Join-Path $root 'target\release\osheep-server.exe') (Join-Path $stage 'service\osheep-server.exe')
$stageSizeMb = [math]::Round((Get-ChildItem $stage -File -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Desktop stage ready: $stageSizeMb MB (Rust service + frontend only)"
