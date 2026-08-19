param(
  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath
)

$target = [IO.Path]::GetFullPath($ExecutablePath)

Get-Process -Name 'node' -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $candidate = [IO.Path]::GetFullPath($_.Path)
    if ([StringComparer]::OrdinalIgnoreCase.Equals($candidate, $target)) {
      Stop-Process -InputObject $_ -Force -ErrorAction SilentlyContinue
      $_.WaitForExit(5000) | Out-Null
    }
  } catch {
    # Ignore inaccessible and already-exited processes. They cannot hold the file.
  }
}
