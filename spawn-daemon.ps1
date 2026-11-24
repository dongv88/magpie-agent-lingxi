param(
  [Parameter(Mandatory = $true)][string]$Bun,
  [Parameter(Mandatory = $true)][string]$Daemon,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $false)][string]$DataDir,
  [Parameter(Mandatory = $false)][string]$Launcher,
  [switch]$NoLauncher
)

# Create the daemon through WMI so it is not a child of magpie's plugin host
# (a child would be killed with the host's job object).
#
# A console program created this way gets a new, visible console window, which
# is the stray command window that used to show up on every magpie start. So
# what WMI creates here is wscript.exe (spawn-daemon.vbs): a GUI-subsystem
# program, which is given no console at all, and it starts Bun with its own
# window hidden.
if (-not $DataDir) { $DataDir = $WorkDir }
New-Item -ItemType Directory -Path $DataDir -Force -ErrorAction SilentlyContinue | Out-Null

$log = Join-Path $DataDir "spawn-error.log"
function Write-Note([string]$text) {
  try { $text | Out-File $log -Append -Encoding utf8 } catch {}
}

$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"

if (-not $NoLauncher -and $Launcher -and (Test-Path $Launcher) -and (Test-Path $wscript)) {
  $cmd = '"' + $wscript + '" //B //Nologo "' + $Launcher + '" "' + $Bun + '" "' + $Daemon + '" "' + $WorkDir + '" "' + $DataDir + '"'
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine      = $cmd
      CurrentDirectory = $WorkDir
    }
    if ($r.ReturnValue -eq 0) { exit 0 }
    Write-Note "launcher create returned $($r.ReturnValue)"
  } catch {
    Write-Note "launcher create failed: $($_.Exception.Message)"
  }
}

# Fallback: create Bun directly. It runs the same, but Bun gets a visible
# console window. Reached only when wscript is missing or refuses to run.
Write-Note "falling back to a direct create; a console window may appear"
$cmd = '"' + $Bun + '" "' + $Daemon + '"'
try {
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $cmd
    CurrentDirectory = $WorkDir
  }
  if ($r.ReturnValue -ne 0) {
    Write-Note "Win32_Process.Create returned $($r.ReturnValue)"
  }
} catch {
  Write-Note "direct create failed: $($_.Exception.Message)"
}
