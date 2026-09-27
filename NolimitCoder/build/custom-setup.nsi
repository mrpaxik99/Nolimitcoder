; NolimitCoder V4 - FULL CUSTOM dark installer (no MUI, pure nsDialogs).
; Dark background on every dialog, white text, green accents, themed buttons.
; Built with: node build/makensis-run.js  (Devel: npm run build:installer)
Unicode True
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef APP_NAME
  !define APP_NAME "NolimitCoder V4"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "3.0.13"
!endif
!ifndef APP_PUBLISHER
  !define APP_PUBLISHER "NolimitCode"
!endif
!ifndef APP_ID
  !define APP_ID "NolimitCoderV4"
!endif
!ifndef APP_EXE
  !define APP_EXE "NolimitCoder V3.exe"
!endif
!ifndef SRC_DIR
  !define SRC_DIR "win-unpacked"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "NolimitCoder V4 Setup.exe"
!endif
!ifndef LICENSE_FILE
  !define LICENSE_FILE "license.txt"
!endif
!ifndef LOGO_ICO
  !define LOGO_ICO "welcome-logo.ico"
!endif
!ifndef APP_ICON
  !define APP_ICON "icon.ico"
!endif

Name "${APP_NAME}"
Caption "${APP_NAME} Setup"
UninstallCaption "${APP_NAME} Uninstall"
BrandingText "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
Icon "${APP_ICON}"
InstallDir "$LOCALAPPDATA\Programs\NolimitCoder"
InstallDirRegKey HKCU "Software\NolimitCoder" "InstallDir"
RequestExecutionLevel user
XPStyle on
ManifestDPIAware true
SetCompressor /SOLID lzma

; Colors: #0B0B0E background, #EDEDED text, #9E9E9E gray, #30D158 green
!define C_BG 0x000E0B0B
!define C_TEXT 0xEDEDED
!define C_GRAY 0x9E9E9E
!define C_GREEN 0x58D132
!define ID_NEXT 1
!define ID_BACK 3

Var Dialog
Var DidWork
Var OldBgBrush
Var DarkBrush
Var TitleFont
Var LblStatus
Var BarProgress
Var TxtDir
Var ChkLaunch
Var UnLblStatus
Var UnBarProgress

; ---------- dark window: dark titlebar + dark class brush (created once) ----------
!macro DarkSetup FINDNAME
  System::Call 'user32::FindWindow(t "#32770", t "${FINDNAME}") i .r0'
  StrCpy $1 $0
  ${If} $1 != 0
  ${AndIf} $1 != ""
    System::Call 'dwmapi::DwmSetWindowAttribute(i $1, i 20, i *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(i $1, i 19, i *i 1, i 4)'
    System::Call 'gdi32::CreateSolidBrush(i ${C_BG}) i .r0'
    StrCpy $DarkBrush $0
  ${EndIf}
!macroend
!macro DarkCleanup FINDNAME
  System::Call 'user32::FindWindow(t "#32770", t "${FINDNAME}") i .r0'
  StrCpy $1 $0
  ${If} $1 != 0
  ${AndIf} $1 != ""
  ${AndIf} $OldBgBrush != ""
  ${AndIf} $OldBgBrush != "error"
    System::Call 'user32::SetClassLongA(i $1, i -10, i $OldBgBrush)'
  ${EndIf}
  ${If} $DarkBrush != ""
    System::Call 'gdi32::DeleteObject(i $DarkBrush) i .r0'
    StrCpy $DarkBrush ""
  ${EndIf}
  ${If} $TitleFont != ""
    System::Call 'gdi32::DeleteObject(i $TitleFont) i .r0'
    StrCpy $TitleFont ""
  ${EndIf}
!macroend
; Re-apply the dark brush AFTER nsDialogs::Create (creating a page may reset it).
; Call after every nsDialogs::Create in every page, installer and uninstaller.
!macro DarkPageNow
  Push $0
  Push $1
  ${If} $Dialog != 0
  ${AndIf} $Dialog != ""
  ${AndIf} $DarkBrush != ""
    System::Call 'uxtheme::SetWindowTheme(i $Dialog, i 0, i 0)'
    System::Call 'user32::SetClassLongA(i $Dialog, i -10, i $DarkBrush)'
  ${EndIf}
  Pop $1
  Pop $0
!macroend

Function .onGUIInit
FunctionEnd
Function .onGUIEnd
  !insertmacro DarkCleanup "${APP_NAME} Setup"
FunctionEnd
Function un.onGUIInit
FunctionEnd
Function un.onGUIEnd
  !insertmacro DarkCleanup "${APP_NAME} Uninstall"
FunctionEnd
; First page only: find window, dark titlebar, create brush.
Function EnsureDark
  ${If} $DarkBrush != ""
    Return
  ${EndIf}
  !insertmacro DarkSetup "${APP_NAME} Setup"
FunctionEnd
Function un.EnsureDark
  ${If} $DarkBrush != ""
    Return
  ${EndIf}
  !insertmacro DarkSetup "${APP_NAME} Uninstall"
FunctionEnd

; Shared helpers as MACROS (not Functions) so both installer and uninstaller code can use them.
!macro MakeTitleFont
  Push $0
  Push $1
  ${If} $TitleFont == ""
    System::Call 'gdi32::CreateFont(i -19, i 0, i 0, i 0, i 700, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, t "Segoe UI") i .r0'
    StrCpy $TitleFont $0
  ${EndIf}
  Pop $1
  Pop $0
!macroend
; Big white title at (12, Y): !insertmacro PageTitle "Text" Y
!macro PageTitle TEXT Y
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro MakeTitleFont
  ${NSD_CreateLabel} 12 ${Y} 280 26 "${TEXT}"
  Pop $2
  SendMessage $2 ${WM_SETFONT} $TitleFont 1
  SetCtlColors $2 ${C_TEXT} transparent
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
; Outer nav button text: !insertmacro NavText "Text" ID
!macro NavText TEXT ID
  Push $0
  Push $1
  Push $2
  GetDlgItem $2 $HWNDPARENT ${ID}
  SendMessage $2 ${WM_SETTEXT} 0 "STR:${TEXT}"
  Pop $2
  Pop $1
  Pop $0
!macroend
!macro ClickNext
  Push $0
  GetDlgItem $0 $HWNDPARENT ${ID_NEXT}
  EnableWindow $0 1
  SendMessage $0 ${BM_CLICK} 0 0
  Pop $0
!macroend
!macro DisableBackNext
  Push $0
  GetDlgItem $0 $HWNDPARENT ${ID_BACK}
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT ${ID_NEXT}
  EnableWindow $0 0
  Pop $0
!macroend
!macro SetProg N
  Push $0
  Push $1
  ${If} $BarProgress != 0
  ${AndIf} $BarProgress != ""
    SendMessage $BarProgress ${PBM_SETPOS} ${N} 0
  ${EndIf}
  Pop $1
  Pop $0
!macroend
!macro SetPhase TEXT
  Push $0
  Push $1
  ${If} $LblStatus != 0
  ${AndIf} $LblStatus != ""
    SendMessage $LblStatus ${WM_SETTEXT} 0 "STR:${TEXT}"
  ${EndIf}
  Pop $1
  Pop $0
  Sleep 120
!macroend
!macro SetUnProg N
  Push $0
  Push $1
  SendMessage $UnBarProgress ${PBM_SETPOS} ${N} 0
  Pop $1
  Pop $0
  Sleep 150
!macroend

; ================= INSTALL PAGES =================
Page custom WelcomeShow
Page custom LicenseShow
Page custom DirShow DirLeave
Page custom InstallShow
Page custom FinishShow FinishLeave

Function WelcomeShow
  Call EnsureDark
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  !insertmacro DarkPageNow
  InitPluginsDir
  File /oname=$PLUGINSDIR\logo.ico "${LOGO_ICO}"
  ${NSD_CreateIcon} 12 12 56 56 ""
  Pop $1
  System::Call 'user32::LoadImage(i 0, t "$PLUGINSDIR\logo.ico", i ${IMAGE_ICON}, i 64, i 64, i 0x10) i .r0'
  ${If} $0 != 0
    SendMessage $1 ${STM_SETIMAGE} ${IMAGE_ICON} $0
  ${EndIf}
  !insertmacro PageTitle "NolimitCoder V4" 14
  ${NSD_CreateLabel} 76 44 214 12 "Version ${APP_VERSION}  ·  by ${APP_PUBLISHER}"
  Pop $0
  SetCtlColors $0 ${C_GREEN} transparent
  ${NSD_CreateLabel} 12 76 280 30 "AI chat with NolimitCoder models.$\r$\nFast setup  ·  No API key  ·  Windows 64-bit"
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  ${NSD_CreateLabel} 12 122 280 12 "Click Next to install."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  nsDialogs::Show
FunctionEnd

Function LicenseShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  !insertmacro DarkPageNow
  !insertmacro NavText "I Agree" ${ID_NEXT}
  !insertmacro PageTitle "License Agreement" 12
  ${NSD_CreateLabel} 12 42 280 12 "Please review the terms before installing."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  nsDialogs::CreateControl "EDIT" "${DEFAULT_STYLES}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL}" "0" 12 58 276 92 ""
  Pop $0
  FileOpen $1 "${LICENSE_FILE}" r
  ${If} $1 != ""
    LicenseLoop:
      ClearErrors
      FileRead $1 $2
      IfErrors LicenseDone
      SendMessage $0 ${EM_REPLACESEL} 0 "STR:$2$\r$\n"
      Goto LicenseLoop
    LicenseDone:
      FileClose $1
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function DirShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  !insertmacro DarkPageNow
  !insertmacro NavText "Next >" ${ID_NEXT}
  !insertmacro PageTitle "Choose Install Location" 12
  ${NSD_CreateLabel} 12 44 280 12 "Where should ${APP_NAME} be installed?"
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  ${NSD_CreateDirRequest} 12 62 200 13 "$INSTDIR"
  Pop $TxtDir
  ${NSD_CreateBrowseButton} 218 61 62 15 "Browse…"
  Pop $0
  ${NSD_OnClick} $0 OnBrowseDir
  ${NSD_CreateLabel} 12 84 280 26 "About 300 MB of free space is required.$\r$\nYour projects and settings stay untouched."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  nsDialogs::Show
FunctionEnd
Function OnBrowseDir
  Pop $0
  nsDialogs::SelectFolderDialog "Select install folder" "$INSTDIR"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $TxtDir "$0"
  ${EndIf}
FunctionEnd
Function DirLeave
  ${NSD_GetText} $TxtDir $INSTDIR
FunctionEnd

Function InstallShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  !insertmacro DarkPageNow
  !insertmacro PageTitle "Installing…" 12
  ${NSD_CreateLabel} 12 48 280 12 "Copying files…"
  Pop $LblStatus
  SetCtlColors $LblStatus ${C_GREEN} transparent
  ${NSD_CreateProgressBar} 12 66 276 14 ""
  Pop $BarProgress
  ${NSD_CreateLabel} 12 88 280 24 "${APP_NAME} ${APP_VERSION}$\r$\nPlease wait, this takes a moment."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  !insertmacro DisableBackNext
  ${NSD_CreateTimer} InstallTimer 250
  nsDialogs::Show
FunctionEnd
Function InstallTimer
  ${NSD_KillTimer} InstallTimer
  Call DoInstallFiles
  StrCpy $DidWork 1
  !insertmacro ClickNext
FunctionEnd

; The real work — called from the install page (GUI) and from the hidden section (silent).
Function DoInstallFiles
  SetShellVarContext current
  !insertmacro SetPhase "Removing previous version…"
  !insertmacro SetProg 6
  StrLen $0 $INSTDIR
  ${If} $0 <= 10
    Abort "Invalid install folder."
  ${EndIf}
  StrCpy $1 0
  RetryRm:
    RMDir /r "$INSTDIR"
    IfFileExists "$INSTDIR\${APP_EXE}" 0 RmOk
    IntOp $1 $1 + 1
    ${If} $1 >= 5
      Abort "Could not remove the previous version (files are locked). Close ${APP_NAME} and try again."
    ${EndIf}
    IfSilent SilentLocked
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Some files are locked (is ${APP_NAME} running?). Close it and click Retry." IDRETRY RetryRm
    Abort "Installation cancelled. No files were changed."
  SilentLocked:
    Abort "Could not remove the previous version (is ${APP_NAME} running?). Close it and run setup again."
  RmOk:
  !insertmacro SetPhase "Copying application files…"
  !insertmacro SetProg 18
  SetOutPath "$INSTDIR"
  File "${SRC_DIR}\*.exe"
  File "${SRC_DIR}\*.dll"
  !insertmacro SetPhase "Copying libraries…"
  !insertmacro SetProg 45
  File "${SRC_DIR}\*.pak"
  File "${SRC_DIR}\*.bin"
  File "${SRC_DIR}\*.dat"
  File "${SRC_DIR}\LICENSE*"
  !insertmacro SetPhase "Copying resources…"
  !insertmacro SetProg 62
  File /r "${SRC_DIR}\locales"
  !insertmacro SetProg 80
  File /r "${SRC_DIR}\resources"
  !insertmacro SetPhase "Creating shortcuts…"
  !insertmacro SetProg 90
  CreateDirectory "$SMPROGRAMS\NolimitCoder"
  CreateShortcut "$SMPROGRAMS\NolimitCoder\NolimitCoder.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\NolimitCoder\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\NolimitCoder.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  !insertmacro SetPhase "Writing uninstall info…"
  !insertmacro SetProg 96
  WriteRegStr HKCU "Software\NolimitCoder" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  !insertmacro SetProg 100
  !insertmacro SetPhase "Done."
FunctionEnd

Function FinishShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  !insertmacro DarkPageNow
  !insertmacro NavText "Finish" ${ID_NEXT}
  !insertmacro PageTitle "Installation complete" 12
  ${NSD_CreateLabel} 12 44 280 24 "${APP_NAME} is ready in:$\r$\n$INSTDIR"
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  ${NSD_CreateCheckBox} 12 76 280 14 "Launch NolimitCoder now"
  Pop $ChkLaunch
  SetCtlColors $ChkLaunch ${C_TEXT} transparent
  SendMessage $ChkLaunch ${BM_SETCHECK} 1 0
  nsDialogs::Show
FunctionEnd
Function FinishLeave
  SendMessage $ChkLaunch ${BM_GETCHECK} 0 0 $0
  ${If} $0 == 1
    Exec '"$INSTDIR\${APP_EXE}"'
  ${EndIf}
FunctionEnd

; Hidden section: runs ONLY when pages were skipped (silent /S install).
Section "-hidden"
  ${If} $DidWork == 1
    Return
  ${EndIf}
  Call DoInstallFiles
SectionEnd

; ================= UNINSTALL =================
UninstPage custom un.ConfirmShow
UninstPage custom un.WorkShow
UninstPage custom un.FinishShow

Function un.ConfirmShow
  Call un.EnsureDark
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  !insertmacro DarkPageNow
  !insertmacro NavText "Uninstall" ${ID_NEXT}
  !insertmacro PageTitle "Uninstall ${APP_NAME}" 12
  ${NSD_CreateLabel} 12 44 280 36 "This removes the application, shortcuts and registry entries.$\r$\nYour projects and settings are kept."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  nsDialogs::Show
FunctionEnd

Function un.WorkShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  !insertmacro DarkPageNow
  !insertmacro NavText "Close" ${ID_NEXT}
  !insertmacro PageTitle "Uninstalling…" 12
  ${NSD_CreateLabel} 12 48 280 12 "Removing files…"
  Pop $UnLblStatus
  SetCtlColors $UnLblStatus ${C_GREEN} transparent
  ${NSD_CreateProgressBar} 12 66 276 14 ""
  Pop $UnBarProgress
  !insertmacro DisableBackNext
  ${NSD_CreateTimer} un.WorkTimer 250
  nsDialogs::Show
FunctionEnd
Function un.WorkTimer
  ${NSD_KillTimer} un.WorkTimer
  Call un.DoUninstall
  StrCpy $DidWork 1
  !insertmacro ClickNext
FunctionEnd

Function un.DoUninstall
  SetShellVarContext current
  StrLen $0 $INSTDIR
  ${If} $0 < 10
    Abort "Install folder not found."
  ${EndIf}
  !insertmacro SetUnProg 20
  Delete "$DESKTOP\NolimitCoder.lnk"
  Delete "$SMPROGRAMS\NolimitCoder\NolimitCoder.lnk"
  Delete "$SMPROGRAMS\NolimitCoder\Uninstall.lnk"
  RMDir "$SMPROGRAMS\NolimitCoder"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  !insertmacro SetUnProg 55
  RMDir /r "$INSTDIR"
  !insertmacro SetUnProg 100
FunctionEnd

Function un.FinishShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  !insertmacro DarkPageNow
  !insertmacro NavText "Close" ${ID_NEXT}
  !insertmacro PageTitle "Uninstall complete" 12
  ${NSD_CreateLabel} 12 48 280 24 "${APP_NAME} was removed from your PC.$\r$\nYour projects and settings were kept."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  nsDialogs::Show
FunctionEnd

Section "Uninstall"
  ${If} $DidWork == 1
    Return
  ${EndIf}
  Call un.DoUninstall
SectionEnd
