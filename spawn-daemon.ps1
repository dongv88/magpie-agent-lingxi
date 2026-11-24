param(
  [Parameter(Mandatory = $true)][string]$Bun,
  [Parameter(Mandatory = $true)][string]$Daemon,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $false)][string]$DataDir
)

# Create the daemon through WMI so it is not a child of magpie's plugin host
# (a child would be killed with the host's job object).
if (-not $DataDir) { $DataDir = $WorkDir }
New-Item -ItemType Directory -Path $DataDir -Force -ErrorAction SilentlyContinue | Out-Null
$cmd = '"' + $Bun + '" "' + $Daemon + '"'
try {
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $cmd
    CurrentDirectory = $WorkDir
  }
  if ($r.ReturnValue -ne 0) {
    "Win32_Process.Create returned $($r.ReturnValue)" | Out-File (Join-Path $DataDir "spawn-error.log") -Append
  }
} catch {
  $_ | Out-File (Join-Path $DataDir "spawn-error.log") -Append
}
