param(
  [int]$CdpPort = 9222
)

# Find WPS Lingxi and start it with the DevTools port the plugin syncs over.
# Quit Lingxi first: an already-running instance only gets focused and keeps
# its old command line (no debug port).

$ErrorActionPreference = "SilentlyContinue"
$data = Join-Path $env:USERPROFILE ".config\magpie\lingxi-agent"
$install = Join-Path $data "install.json"
$exe = $null

if (Test-Path $install) {
  try { $exe = (Get-Content $install -Raw | ConvertFrom-Json).exe } catch {}
}

if (-not $exe) {
  $d = Get-ItemProperty `
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', `
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', `
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' `
    -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match '灵犀|lingxi' } |
    Select-Object -First 1
  if ($d) {
    if ($d.DisplayIcon) { $exe = ($d.DisplayIcon -split ',')[0] }
    elseif ($d.InstallLocation) { $exe = Join-Path $d.InstallLocation 'WPS 灵犀.exe' }
  }
}

if (-not $exe -or -not (Test-Path $exe)) {
  $local = $env:LOCALAPPDATA
  $candidates = @(
    (Join-Path $local 'Programs\lingxi-desktop\WPS 灵犀.exe'),
    (Join-Path $local 'Programs\WPS 灵犀\WPS 灵犀.exe'),
    'C:\Program Files\WPS 灵犀\WPS 灵犀.exe',
    'C:\Program Files (x86)\WPS 灵犀\WPS 灵犀.exe'
  )
  $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $exe -or -not (Test-Path $exe)) {
  Write-Host "WPS 灵犀 not found. Install it, or set LINGXI_EXE to its exe path."
  exit 1
}

Write-Host "Starting $exe with --remote-debugging-port=$CdpPort"
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$CdpPort"
