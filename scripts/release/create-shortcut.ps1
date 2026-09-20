# Creates a desktop shortcut for the portable A-share K-line trainer.
# ASCII-only on purpose: Windows PowerShell 5.1 misreads UTF-8 scripts saved
# without a BOM, so the visible Chinese shortcut label is built from Unicode
# code points instead of literal characters.
# No admin rights, no PATH changes, no per-machine install: everything stays
# inside the package directory plus one .lnk on the user's desktop.
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageRoot
)
$ErrorActionPreference = 'Stop'
try {
  $PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
  $startScript = Join-Path $PackageRoot 'Start.cmd'
  if (-not (Test-Path -LiteralPath $startScript)) {
    Write-Host "[error] Start.cmd not found in $PackageRoot; re-extract the full package."
    exit 1
  }

  # "K" + U+7EBF U+8BAD U+7EC3 U+5668 = the Chinese label for K-line trainer.
  $label = -join [char[]](0x004B, 0x7EBF, 0x8BAD, 0x7EC3, 0x5668)
  $desktop = [Environment]::GetFolderPath('Desktop')
  $linkPath = Join-Path $desktop ($label + '.lnk')

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($linkPath)
  $shortcut.TargetPath = $startScript
  $shortcut.WorkingDirectory = $PackageRoot
  $shortcut.WindowStyle = 7  # start minimized; the console closes on success
  $shortcut.Description = 'A-share K-line trainer (local only, http://127.0.0.1)'
  $icon = Join-Path $PackageRoot 'assets\trainer.ico'
  if (Test-Path -LiteralPath $icon) {
    $shortcut.IconLocation = "$icon,0"
  }
  $shortcut.Save()

  Write-Host "Desktop shortcut created: $linkPath"
  Write-Host "Target: $startScript"
  Write-Host "Keep the package folder in place; the shortcut starts it from there."
  exit 0
} catch {
  Write-Host "[error] $($_.Exception.Message)"
  exit 1
}
