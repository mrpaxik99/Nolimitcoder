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
BrandingText "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
Icon "${APP_ICON}"
InstallDir "$LOCALAPPDATA\Programs\NolimitCoder"
InstallDirRegKey HKCU "Software\NolimitCoder" "InstallDir"
RequestExecutionLevel user
XPStyle on
ManifestDPIAware true
SetCompressor /SOLID lzma
SetShellVarContext current

; Colors: #0B0B0E background, #EDEDED text, #9E9E9E gray, #30D158 green
!define C_BG 0x000E0B0B
!define C_TEXT 0xEDEDED
!define C_GRAY 0x9E9E9E
!define C_GREEN 0x58D132
!define WM_SETTEXT 0x000C
!define WM_SETFONT 0x0030
!define BM_CLICK 0x00F5
!define BM_GETCHECK 0x00F0
!define BM_SETCHECK 0x00F1
!define STM_SETIMAGE 0x0172
!define IMAGE_ICON 0x0001
!define PBM_SETPOS 1026
!define EM_REPLACESEL 194
!define ID_NEXT 1
!define ID_CANCEL 2
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

; ---------- dark window: dark titlebar + dark background for ALL dialogs ----------
!macro DarkSetup FINDNAME
  System::Call 'user32::FindWindow(t "#32770", t "${FINDNAME}") i .r0'
  ${If} $0 != 0
    System::Call 'dwmapi::DwmSetWindowAttribute(i $0, i 20, i *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(i $0, i 19, i *i 1, i 4)'
    System::Call 'user32::GetClassLongPtrA(i $0, i -10) p .r0'
    StrCpy $OldBgBrush $0
    System::Call 'gdi32::CreateSolidBrush(i ${C_BG}) p .r0'
    StrCpy $DarkBrush $0
    System::Call 'user32::SetClassLongPtrA(i $0, i -10, p $DarkBrush)'
  ${EndIf}
!macroend
!macro DarkCleanup FINDNAME
  System::Call 'user32::FindWindow(t "#32770", t "${FINDNAME}") i .r0'
  ${If} $0 != 0
  ${AndIf} $OldBgBrush != ""
    System::Call 'user32::SetClassLongPtrA(i $0, i -10, p $OldBgBrush)'
  ${EndIf}
  ${If} $DarkBrush != ""
    System::Call 'gdi32::DeleteObject(p $DarkBrush) i .r0'
    StrCpy $DarkBrush ""
  ${EndIf}
  ${If} $TitleFont != ""
    System::Call 'gdi32::DeleteObject(p $TitleFont) i .r0'
    StrCpy $TitleFont ""
  ${EndIf}
!macroend

Function .onGUIInit
  !insertmacro DarkSetup "$(^Name)"
FunctionEnd
Function .onGUIEnd
  !insertmacro DarkCleanup "$(^Name)"
FunctionEnd
Function un.onGUIInit
  !insertmacro DarkSetup "$(^Name)"
FunctionEnd
Function un.onGUIEnd
  !insertmacro DarkCleanup "$(^Name)"
FunctionEnd

Function MakeTitleFont
  Push $0
  Push $1
  ${If} $TitleFont == ""
    System::Call 'gdi32::CreateFont(i -19, i 0, i 0, i 0, i 700, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, t "Segoe UI") p .r0'
    StrCpy $TitleFont $0
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd
; Set outer nav button text. Usage: Push "Text" / Push ID / Call NavText
Function NavText
  Exch $0
  Exch $1
  Push $2
  GetDlgItem $2 $HWNDPARENT $0
  SendMessage $2 ${WM_SETTEXT} 0 "STR:$1"
  Pop $2
  Push $1
  Push $0
FunctionEnd
Function ClickNext
  Push $0
  GetDlgItem $0 $HWNDPARENT ${ID_NEXT}
  EnableWindow $0 1
  SendMessage $0 ${BM_CLICK} 0 0
  Pop $0
FunctionEnd
Function DisableBackNext
  Push $0
  GetDlgItem $0 $HWNDPARENT ${ID_BACK}
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT ${ID_NEXT}
  EnableWindow $0 0
  Pop $0
FunctionEnd
; Big white title at (12, Y). Usage: Push text / Push Y / Call PageTitle (returns nothing)
Function PageTitle
  Exch $0
  Exch $1
  Push $2
  Push $3
  Call MakeTitleFont
  ${NSD_CreateLabel} 12 $0 280 26 "$1"
  Pop $2
  SendMessage $2 ${WM_SETFONT} $TitleFont 1
  SetCtlColors $2 ${C_TEXT} transparent
  Pop $3
  Push $1
  Push $0
FunctionEnd

; ================= INSTALL PAGES =================
Page custom WelcomeShow
Page custom LicenseShow
Page custom DirShow
Page custom InstallShow
Page custom FinishShow

Function WelcomeShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\logo.ico "${LOGO_ICO}"
  ${NSD_CreateIcon} 12 12 56 56 ""
  Pop $0
  System::Call 'user32::LoadImage(i 0, t "$PLUGINSDIR\logo.ico", i ${IMAGE_ICON}, i 64, i 64, i 0x10) p .r0'
  ${If} $0 != 0
    SendMessage $0 ${STM_SETIMAGE} ${IMAGE_ICON} $0
  ${EndIf}
  Push "NolimitCoder V4"
  Push 14
  Call PageTitle
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
  Push "Next >"
  Push ${ID_NEXT}
  Call NavText
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  Push "License Agreement"
  Push 12
  Call PageTitle
  ${NSD_CreateLabel} 12 42 280 12 "Please review the terms before installing."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  nsDialogs::CreateControl "EDIT" "${DEFAULT_STYLES}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL}" "0" 12 58 276 92 ""
  Pop $0
  FileOpen $1 "${LICENSE_FILE}" r
  ${If} $1 != ""
    LicenseLoop:
      FileRead $1 $2
      IfErrors LicenseDone
      SendMessage $0 ${EM_REPLACESEL} 0 "STR:$2$\r$\n"
      Goto LicenseLoop
    LicenseDone:
      FileClose $1
  ${EndIf}
  nsDialogs::Show
  Push "I Agree"
  Push ${ID_NEXT}
  Call NavText
FunctionEnd

Function DirShow
  Push "Next >"
  Push ${ID_NEXT}
  Call NavText
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  Push "Choose Install Location"
  Push 12
  Call PageTitle
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
  Push "Installing…"
  Push 12
  Call PageTitle
  ${NSD_CreateLabel} 12 48 280 12 "Copying files…"
  Pop $LblStatus
  SetCtlColors $LblStatus ${C_GREEN} transparent
  ${NSD_CreateProgressBar} 12 66 276 14 ""
  Pop $BarProgress
  ${NSD_CreateLabel} 12 88 280 24 "${APP_NAME} ${APP_VERSION}$\r$\nPlease wait, this takes a moment."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  Call DisableBackNext
  ${NSD_CreateTimer} InstallTimer 250
  nsDialogs::Show
FunctionEnd
Function InstallTimer
  ${NSD_KillTimer} InstallTimer
  Call DoInstallFiles
  StrCpy $DidWork 1
  Call ClickNext
FunctionEnd

Function SetProg
  Exch $0
  Push $1
  ${If} $BarProgress != 0
  ${AndIf} $BarProgress != ""
    SendMessage $BarProgress ${PBM_SETPOS} $0 0
  ${EndIf}
  Pop $1
  Push $0
FunctionEnd
Function SetPhase
  Exch $0
  Push $1
  ${If} $LblStatus != 0
  ${AndIf} $LblStatus != ""
    SendMessage $LblStatus ${WM_SETTEXT} 0 "STR:$0"
  ${EndIf}
  Pop $1
  Push $0
  Sleep 120
FunctionEnd

; The real work — called from the install page (GUI) and from the hidden section (silent).
Function DoInstallFiles
  Push "Removing previous version…"
  Call SetPhase
  Push 6
  Call SetProg
  StrLen $0 $INSTDIR
  ${If} $0 > 10
    RMDir /r "$INSTDIR"
  ${EndIf}
  Push "Copying application files…"
  Call SetPhase
  Push 18
  Call SetProg
  SetOutPath "$INSTDIR"
  CopyLoop:
    ClearErrors
    File "${SRC_DIR}\*.exe"
    File "${SRC_DIR}\*.dll"
    IfErrors CopyRetry
    Goto CopyLibs
  CopyRetry:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Some files are locked (is ${APP_NAME} running?). Close it and click Retry." IDRETRY CopyLoop
    Abort "Installation cancelled. No files were changed."
  CopyLibs:
  Push "Copying libraries…"
  Call SetPhase
  Push 45
  Call SetProg
  File "${SRC_DIR}\*.pak"
  File "${SRC_DIR}\*.bin"
  File "${SRC_DIR}\*.dat"
  File "${SRC_DIR}\LICENSE*"
  Push "Copying resources…"
  Call SetPhase
  Push 62
  Call SetProg
  File /r "${SRC_DIR}\locales"
  Push 80
  Call SetProg
  File /r "${SRC_DIR}\resources"
  Push "Creating shortcuts…"
  Call SetPhase
  Push 90
  Call SetProg
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS\NolimitCoder"
  CreateShortcut "$SMPROGRAMS\NolimitCoder\NolimitCoder.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\NolimitCoder\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\NolimitCoder.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  Push "Writing uninstall info…"
  Call SetPhase
  Push 96
  Call SetProg
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
  Push 100
  Call SetProg
  Push "Done."
  Call SetPhase
FunctionEnd

Function FinishShow
  Push "Finish"
  Push ${ID_NEXT}
  Call NavText
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  Push "Installation complete"
  Push 12
  Call PageTitle
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
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  Push "Uninstall ${APP_NAME}"
  Push 12
  Call PageTitle
  Pop $0
  ${NSD_CreateLabel} 12 44 280 36 "This removes the application, shortcuts and registry entries.$\r$\nYour projects and settings are kept."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  Push "Uninstall"
  Push ${ID_NEXT}
  Call NavText
  Pop $0
  nsDialogs::Show
FunctionEnd

Function un.WorkShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  Push "Uninstalling…"
  Push 12
  Call PageTitle
  Pop $0
  ${NSD_CreateLabel} 12 48 280 12 "Removing files…"
  Pop $UnLblStatus
  SetCtlColors $UnLblStatus ${C_GREEN} transparent
  ${NSD_CreateProgressBar} 12 66 276 14 ""
  Pop $UnBarProgress
  Push "Close"
  Push ${ID_NEXT}
  Call NavText
  Pop $0
  Call DisableBackNext
  ${NSD_CreateTimer} un.WorkTimer 250
  nsDialogs::Show
FunctionEnd
Function un.WorkTimer
  ${NSD_KillTimer} un.WorkTimer
  Call un.DoUninstall
  StrCpy $DidWork 1
  Call ClickNext
FunctionEnd

Function un.SetUnProg
  Exch $0
  Push $1
  SendMessage $UnBarProgress ${PBM_SETPOS} $0 0
  Pop $1
  Push $0
  Sleep 150
FunctionEnd

Function un.DoUninstall
  StrLen $0 $INSTDIR
  ${If} $0 < 10
    Abort "Install folder not found."
  ${EndIf}
  Push 20
  Call un.SetUnProg
  Delete "$DESKTOP\NolimitCoder.lnk"
  Delete "$SMPROGRAMS\NolimitCoder\NolimitCoder.lnk"
  Delete "$SMPROGRAMS\NolimitCoder\Uninstall.lnk"
  RMDir "$SMPROGRAMS\NolimitCoder"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  Push 55
  Call un.SetUnProg
  RMDir /r "$INSTDIR"
  Push 100
  Call un.SetUnProg
FunctionEnd

Function un.FinishShow
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  Push "Uninstall complete"
  Push 12
  Call PageTitle
  Pop $0
  ${NSD_CreateLabel} 12 48 280 24 "${APP_NAME} was removed from your PC.$\r$\nYour projects and settings were kept."
  Pop $0
  SetCtlColors $0 ${C_GRAY} transparent
  Push "Close"
  Push ${ID_NEXT}
  Call NavText
  Pop $0
  nsDialogs::Show
FunctionEnd

Section "Uninstall"
  ${If} $DidWork == 1
    Return
  ${EndIf}
  Call un.DoUninstall
SectionEnd
