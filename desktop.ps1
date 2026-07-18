[CmdletBinding()]
param(
  [switch]$Build,
  [string]$RemoteUrl
)

$ErrorActionPreference = 'Stop'
$desktop = Join-Path $PSScriptRoot 'desktop'
$cacheRoot = Join-Path $PSScriptRoot '.cache'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
$env:CARGO_HOME = Join-Path $cacheRoot 'cargo'
$env:npm_config_cache = Join-Path $cacheRoot 'npm'

function Initialize-RustAndMsvc {
  $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
  if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
    $env:Path = "$cargoBin;$env:Path"
  }
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust is required for the Tauri shell. Install it from https://rustup.rs, then reopen the terminal.'
  }

  $vsRoots = @(
    (Join-Path $PSScriptRoot '.tools\BuildTools'),
    (Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio\2022\BuildTools'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools'),
    'C:\BuildTools'
  ) | Where-Object { Test-Path $_ }
  $msvcRoot = $vsRoots |
    ForEach-Object { Get-ChildItem (Join-Path $_ 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue } |
    Sort-Object Name -Descending |
    Select-Object -First 1
  $kitRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
  $kitVersion = Get-ChildItem (Join-Path $kitRoot 'Include') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if (-not $msvcRoot -or -not $kitVersion) {
    throw 'Visual Studio C++ Build Tools and a Windows 10 SDK are required. Run `npx tauri info` for details.'
  }

  $env:Path = "$($msvcRoot.FullName)\bin\Hostx64\x64;$kitRoot\bin\$($kitVersion.Name)\x64;$env:Path"
  $env:Include = "$($msvcRoot.FullName)\include;$kitRoot\Include\$($kitVersion.Name)\shared;$kitRoot\Include\$($kitVersion.Name)\ucrt;$kitRoot\Include\$($kitVersion.Name)\um;$kitRoot\Include\$($kitVersion.Name)\winrt"
  $env:Lib = "$($msvcRoot.FullName)\lib\x64;$kitRoot\Lib\$($kitVersion.Name)\ucrt\x64;$kitRoot\Lib\$($kitVersion.Name)\um\x64"
}

Initialize-RustAndMsvc
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw 'Rust is required for the Tauri shell. Install it from https://rustup.rs, then reopen the terminal.'
}
if (-not (Test-Path (Join-Path $desktop 'node_modules\@tauri-apps\cli'))) {
  Write-Host 'Installing Tauri CLI...'
  Push-Location $desktop
  try { & npm.cmd install } finally { Pop-Location }
}

if ($RemoteUrl) {
  $env:OSHEEP_REMOTE_URL = $RemoteUrl
}

Push-Location $desktop
try {
  if ($Build) {
    & npm.cmd run build
  } else {
    & npm.cmd run dev
  }
} finally {
  Pop-Location
}
