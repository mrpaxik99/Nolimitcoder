# NolimitCoderV2 auto-push — pri kazde zmene automaticky commit + push na GitHub.
# Bezi skryte na pozadi (naplanovana uloha "NolimitCoderV2-AutoPush" pri prihlaseni).
# Log: $env:TEMP\nolimit-autopush.log
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Git = 'C:\Users\PAXI\Tools\Git\cmd\git.exe'
$Log = Join-Path $env:TEMP 'nolimit-autopush.log'
$Branch = 'main'
$QuietSeconds = 30   # push az 30 s po posledni zmene (pocka se na dozneni ukladani)

function Log($m) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m
  Add-Content -LiteralPath $Log -Value $line
  Write-Output $line
}

function Has-Changes {
  $out = & $Git -C $Root status --porcelain 2>&1
  return (($out | Where-Object { $_ -match '\S' }).Count -gt 0)
}

function Try-Push {
  try {
    & $Git -C $Root add -A 2>&1 | Out-Null
    if (!(Has-Changes)) { return }
    $msg = 'auto: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    & $Git -C $Root commit -m $msg 2>&1 | Out-Null
    $p = & $Git -C $Root push origin $Branch 2>&1
    Log ('push OK: ' + $msg)
  } catch {
    Log ('push FAIL: ' + $_.Exception.Message)
  }
}

Log 'watcher start, root=toto'
$w = New-Object System.IO.FileSystemWatcher
$w.Path = $Root
$w.IncludeSubdirectories = $true
$w.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::DirectoryName
$w.EnableRaisingEvents = $true
$lastChange = $null

while ($true) {
  $r = $w.WaitForChanged([System.IO.WatcherChangeTypes]::All, 10000)
  if ($r.TimedOut) {
    if ($lastChange -and ((Get-Date) - $lastChange).TotalSeconds -ge $QuietSeconds) {
      $lastChange = $null
      Try-Push
    }
    continue
  }
  $p = $r.Name
  if ($p -match '(^|\\)\.git(\\|$)') { continue }  # vlastni .git ignorovat (jinak smycka)
  $lastChange = Get-Date
}
