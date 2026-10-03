@echo off
REM NolimitCoderV2 auto-push + auto-build — spusti po prihlaseni, skryte na pozadi.
REM Pri kazde zmene commit + push na GitHub, pri zmene kodu i novy build do dist.
REM Log: %TEMP%\nolimit-autopush.log
start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\DEVELOPER\NolimitCoderV2\auto-push.ps1"
exit