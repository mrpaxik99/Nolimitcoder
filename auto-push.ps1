# NolimitCoderV2 auto-push + auto-build — pri kazde zmene automaticky commit + push
# na GitHub, a pokud se zmenil kod, i novy build do dist (max 1x za 15 min).
# Instalator z distu ve 2x do jineho repa (mrpaxik99/NolimitCoder-Download) —
# to dela publish.ps1 v D:\DEVELOPER\Download New Version.
# Bezi skryte na pozadi (spoustec po prihlaseni: Startup\NolimitCoderV2-AutoPush.bat).
# Log: $env:TEMP\nolimit-autopush.log
$ErrorActionPreference = 'Continue'
# Nikdy zadne interaktivni okno/dotaz: na pozadi by helper-selector / login visel
# donekonecna a dale by to vypadalo jako "zamrzly push". Bez credentialu to spadne
# hned s jasnou hlaskou v logu (push FAIL) a zkusi se to znova priste.
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Git = 'C:\Users\PAXI\Tools\Git\cmd\git.exe'
$Log = Join-Path $env:TEMP 'nolimit-autopush.log'
$BuildMarker = Join-Path $env:TEMP 'nolimit-lastbuild.txt'  # "commit-hash|cas" posledniho buildnuteho stavu
$BuildCooldownMin = 15
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
    & $Git -C $Root push origin $Branch 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Log ('push OK: ' + $msg); Try-Build }
    else { Log 'push FAIL (napr. chybi remote/prihlaseni) — zkusim znovu pri dalsi zmene' }
  } catch {
    Log ('push FAIL: ' + $_.Exception.Message)
  }
}

function Try-Build {
  # Po uspesnem pushi: kdyz se od posledniho buildu zmenil kod, zkompiluj znovu (s cooldownem).
  try {
    $head = ((& $Git -C $Root rev-parse HEAD 2>$null | Out-String) + '').Trim()
    if (!$head) { return }
    $marked = ''
    if (Test-Path -LiteralPath $BuildMarker) { $marked = ((Get-Content -LiteralPath $BuildMarker -Raw) + '').Trim() }
    $parts = $marked -split '\|'
    if ($parts[0] -eq $head) { return }  # tento stav uz je zbuildeny
    if ($parts.Count -ge 2) {
      try { $lastT = [datetime]$parts[1] } catch { $lastT = [datetime]::MinValue }
      if (((Get-Date) - $lastT).TotalMinutes -lt $BuildCooldownMin) { return }
    }
    $since = if ($parts[0]) { $parts[0] } else { 'HEAD~5' }
    # Instalátory ve složce Downloads Updates nejsou změna kódu — ty netřeba buildnout
    $files = ((& $Git -C $Root diff --name-only "$since..HEAD" 2>$null |
      Where-Object { $_ -notlike 'NolimitWebsite/Downloads Updates/*' }) -join "`n") + ''
    if ($files -notmatch 'NolimitCoder/(src|package\.json|proxies/)|NolimitWebsite/') {
      Set-Content -LiteralPath $BuildMarker -Value "$head|$(Get-Date -Format o)"  # jen texty/logy — build netreba
      return
    }
    $npm = $null
    try { $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source } catch {}
    if (!$npm -or $npm -like '*.ps1') {
      $pf = Join-Path ${env:ProgramFiles} 'nodejs\npm.cmd'
      if (Test-Path -LiteralPath $pf) { $npm = $pf }
    }
    if (!$npm) { Log 'auto-build SKIP (npm.cmd nenalezen)'; return }
    Log 'auto-build start...'
    $appDir = Join-Path $Root 'NolimitCoder'
    # .cmd se spousti pres cmd.exe — Start-Process primo na npm.ps1 by Windows otevrel v Poznamkovem bloku
    $proc = Start-Process -FilePath "$env:ComSpec" -ArgumentList @('/c', 'npm', 'run', 'build:win') -WorkingDirectory $appDir -WindowStyle Hidden -Wait -PassThru
    if (!$proc -or $proc.ExitCode -ne 0) { Log ('auto-build FAIL, exit=' + ($proc.ExitCode)); return }
    $distDir = Join-Path $appDir 'dist'
    # Instalátor se jmenuje podle verze (NolimitCoder Setup 1.1.0.exe) — beru nejnovější
    $exe = Get-ChildItem -LiteralPath $distDir -Filter '*Setup*.exe' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (!$exe) { Log 'auto-build FAIL (exe nevzniklo)'; return }
    # Publikace instalátoru má na starosti publish.ps1 v D:\DEVELOPER\Download New Version
    # (sleduje dist a pushne do mrpaxik99/NolimitCoder-Download). Tady se nic nekopíruje.
    Set-Content -LiteralPath $BuildMarker -Value "$head|$(Get-Date -Format o)"
    Log ('auto-build OK — ' + $exe.Name + ' (publikuje publish.ps1)')
  } catch {
    Log ('auto-build ERROR: ' + $_.Exception.Message)
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
  if ($p -match '(^|\\)(node_modules|dist|dist2|build)(\\|$)') { continue }  # vystupy buildu nesmi spoustet dalsi build
  if ($p -match 'NolimitWebsite[\\/]Downloads(\\|$)') { continue }  # kopie instalatoru pro web
  if ($p -match '\.(log|blockmap)$') { continue }  # logy a blokmapy — .exe ve složce Downloads Updates se naopak pushuje
  $lastChange = Get-Date
}
