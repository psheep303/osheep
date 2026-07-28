[CmdletBinding()]
param([string]$NodeBinary)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$desktop = Join-Path $root 'desktop'
$stage = Join-Path $desktop 'stage'

& (Join-Path $PSScriptRoot 'prepare-dev.ps1')

if (-not $NodeBinary) {
  $NodeBinary = (Get-Command node -ErrorAction Stop).Source
}
$NodeBinary = (Resolve-Path $NodeBinary).Path

if (Test-Path $stage) {
  $resolvedStage = (Resolve-Path $stage).Path
  if (-not $resolvedStage.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear stage outside desktop directory: $resolvedStage"
  }
  Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}

$stageBackend = Join-Path $stage 'backend'
New-Item -ItemType Directory -Force -Path $stageBackend | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'frontend') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'node') | Out-Null

Copy-Item (Join-Path $root 'backend\package.json') $stageBackend
Copy-Item (Join-Path $root 'backend\package-lock.json') $stageBackend
Copy-Item (Join-Path $root 'backend\dist') $stageBackend -Recurse
Copy-Item (Join-Path $root 'backend\template-library') $stageBackend -Recurse
Copy-Item (Join-Path $root 'frontend\dist\*') (Join-Path $stage 'frontend') -Recurse
Copy-Item $NodeBinary (Join-Path $stage 'node\node.exe')

Write-Host 'Installing production-only backend dependencies into desktop stage...'
Push-Location $stageBackend
try {
  & npm.cmd ci --omit=dev --no-audit --no-fund
  $npmExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($npmExitCode -ne 0) { throw "npm ci failed with exit code $npmExitCode" }

Write-Host 'Pruning desktop stage...'
$ptyRoot = Join-Path $stageBackend 'node_modules\node-pty'
if (Test-Path $ptyRoot) {
  $prebuilds = Join-Path $ptyRoot 'prebuilds'
  if (Test-Path (Join-Path $prebuilds 'win32-x64')) {
    Get-ChildItem $prebuilds -Directory |
      Where-Object { $_.Name -ne 'win32-x64' } |
      Remove-Item -Recurse -Force
    foreach ($dir in 'third_party', 'deps', 'src') {
      $path = Join-Path $ptyRoot $dir
      if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
  }
}

Push-Location $stageBackend
try {
  & (Join-Path $stage 'node\node.exe') -e "require('node-pty'); console.log('node-pty OK')"
  $nodePtyExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($nodePtyExitCode -ne 0) { throw 'node-pty failed to load after pruning' }

Remove-Item -LiteralPath (Join-Path $stageBackend 'package-lock.json') -Force -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $stageBackend 'dist') -Recurse -Filter '*.test.js' -ErrorAction SilentlyContinue |
  Remove-Item -Force

$nodeSizeMb = [math]::Round((Get-Item (Join-Path $stage 'node\node.exe')).Length / 1MB, 1)
$stageSizeMb = [math]::Round((Get-ChildItem $stage -File -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Desktop stage ready: $stageSizeMb MB (Node runtime: $nodeSizeMb MB)"
