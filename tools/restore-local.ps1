# Put the Lingxi launchers back as 0.1.x found them.
#
# 0.1.x (up to 0.1.4) appended --remote-debugging-port=9222 to every Lingxi
# .lnk and Run value it found, and kept their original arguments in
# shortcuts.json (in the plugin's data dir). This sets each back to those,
# one it still finds carrying the appended port; one whose arguments changed
# some other way is reported, not guessed at, and so is a launcher the file
# does not name.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restore-local.ps1          # reports
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restore-local.ps1 -Apply   # changes
#
# 0.2.0 does not touch launchers at all; this is only for a machine 0.1.x was
# used on. A Lingxi running now keeps the port until it is quit and started
# again.
param([switch]$Apply)
$ErrorActionPreference = "Stop"
$data = Join-Path $env:USERPROFILE ".config\magpie\lingxi-agent"
$backups = Join-Path $data "shortcuts.json"
$port = 'remote-debugging-port'

function Say($m) { Write-Output $m }

$todo = @()
$skipped = @()
if (Test-Path $backups) {
  $list = Get-Content $backups -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($b in $list) {
    if ($b.kind -eq "lnk") {
      if (-not (Test-Path -LiteralPath $b.path)) { $skipped += "missing: $($b.path)"; continue }
      $s = (New-Object -ComObject WScript.Shell).CreateShortcut($b.path)
      $now = [string]$s.Arguments
      if ($now -notmatch $port) { $skipped += "no port any more: $($b.path)"; continue }
      $todo += [pscustomobject]@{ kind = "lnk"; where = $b.path; now = $now; want = [string]$b.args }
    } elseif ($b.kind -eq "run") {
      $k = Get-Item -LiteralPath $b.path -ErrorAction SilentlyContinue
      if (-not $k) { $skipped += "no key: $($b.path)"; continue }
      $now = [string]$k.GetValue($b.name)
      if (-not $now) { $skipped += "no value: $($b.name)"; continue }
      if ($now -notmatch $port) { $skipped += "no port any more: $($b.path) :: $($b.name)"; continue }
      $todo += [pscustomobject]@{ kind = "run"; where = "$($b.path) :: $($b.name)"; now = $now; want = [string]$b.value }
    }
  }
} else {
  Say "no shortcuts.json in ${data}: nothing 0.1.x recorded on this machine"
}

# Only what 0.1.x itself did gets undone: the original arguments, then the
# port it added. One changed in some other way since is left to the user.
$undo = @()
foreach ($t in $todo) {
  $m = [regex]::Match($t.now, '\s*--' + $port + '=(\d+)\s*$')
  if (-not $m.Success -or $t.now.Substring(0, $m.Index) -ne $t.want) {
    $skipped += "changed otherwise, left alone: $($t.where)"
    continue
  }
  $undo += $t
}
$todo = $undo

foreach ($t in $todo) {
  Say "$(if ($Apply) { 'restored' } else { 'would restore' }) $($t.where)"
  Say "    was: $($t.now)"
  Say "    now: $($t.want)"
  if (-not $Apply) { continue }
  if ($t.kind -eq "lnk") {
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($t.where)
    $s.Arguments = $t.want
    $s.Save()
  } else {
    $path, $name = $t.where -split ' :: '
    Set-ItemProperty -LiteralPath $path -Name $name -Value $t.want
  }
}
foreach ($s in $skipped) { Say "skip: $s" }

# launchers still carrying the port that shortcuts.json does not name
Say "--- other launchers with --$port ---"
$roots = @(
  [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'),
  [Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)
$known = @($todo | ForEach-Object { ($_.where -split ' :: ')[0].ToLower() })
$others = 0
foreach ($r in $roots) {
  if (-not $r -or -not (Test-Path $r)) { continue }
  Get-ChildItem $r -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName)
    if ([string]$s.Arguments -match $port -and $known -notcontains $_.FullName.ToLower()) {
      Say "OTHER $($_.FullName) :: $($s.Arguments)"
      $script:others++
    }
  }
}
foreach ($rk in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run') {
  $p = Get-ItemProperty -LiteralPath $rk -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  foreach ($n in $p.PSObject.Properties) {
    if ($n.Name -like 'PS*') { continue }
    if ([string]$n.Value -match $port) { Say "OTHER $rk :: $($n.Name) = $($n.Value)"; $others++ }
  }
}
if ($others -eq 0) { Say "none" }
Say "$(if ($Apply) { 'restored' } else { 'would restore' }) $($todo.Count) launcher(s), skipped $($skipped.Count)"
