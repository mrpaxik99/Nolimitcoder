; NolimitCoder V3 - dark installer (NSIS / MUI2)
; - tmavy titlebar (DWMWA_USE_IMMERSIVE_DARK_MODE) a tmave pozadi vnejsiho dialogu
; - tmave bitmapy (sidebar/header) pres volby electron-builderu
; - licence zustava citelny dokument; tlacitka zustavaji systemova
;   (NSIS pres electron-builder neumoznuje prebarvit vnitrky MUI stranek:
;   zadny podporovany hook se z include souboru neexpanduje.)

!macro DarkWindow
  System::Call 'user32::FindWindow(t "#32770", t "$(^Name)") i .r0'
  StrCmp $0 0 +4
  System::Call 'dwmapi::DwmSetWindowAttribute(i $0, i 20, i *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(i $0, i 19, i *i 1, i 4)'
  SetCtlColors $0 0xEDEDED 0x0B0B0E
!macroend

!macro customInit
  !insertmacro DarkWindow
!macroend

!macro customUnInit
  !insertmacro DarkWindow
!macroend
