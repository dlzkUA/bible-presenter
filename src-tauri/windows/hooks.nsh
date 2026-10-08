; Extra installer steps for Bible Presenter (Tauri NSIS hooks).

; Bible Presenter 2.x was built with Electron and installed elsewhere
; (%LOCALAPPDATA%\Programs\Bible Presenter). Remove it first so there is one
; program and one set of shortcuts. Songs, Bibles and settings live in
; %APPDATA%\BiblePresenter and are kept: the old uninstaller never deletes them.
!define BP2_GUID "9dfcaa7d-55b7-587c-bede-f59d7ee96c70"

!macro BP_REMOVE_V2 ROOT FLAG
  ReadRegStr $R5 ${ROOT} "Software\${BP2_GUID}" "InstallLocation"
  ${If} $R5 != ""
  ${AndIf} ${FileExists} "$R5\Uninstall Bible Presenter.exe"
    DetailPrint "Removing Bible Presenter 2 (your songs and settings stay)..."
    nsExec::ExecToLog 'taskkill /F /T /IM "Bible Presenter.exe"'
    Pop $R6
    Sleep 800
    ; _?= runs the old uninstaller in place, so this waits until it is done.
    ExecWait '"$R5\Uninstall Bible Presenter.exe" /S ${FLAG} _?=$R5' $R6
    Delete "$R5\Uninstall Bible Presenter.exe"
    RMDir "$R5"
    DeleteRegKey ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${BP2_GUID}"
    DeleteRegKey ${ROOT} "Software\${BP2_GUID}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro BP_REMOVE_V2 HKCU /currentuser
  !insertmacro BP_REMOVE_V2 HKLM /allusers
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Started by version 2's own updater: start the new version afterwards.
  ${GetOptions} $CMDLINE "--force-run" $R7
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}

  ; Offer LibreOffice (for PowerPoint files) on a fresh, attended install only.
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
  ${OrIf} ${Silent}
    Goto bp_lo_done
  ${EndIf}
  ${GetOptions} $CMDLINE "--updated" $R7
  ${IfNot} ${Errors}
    Goto bp_lo_done
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\LibreOffice\program\soffice.exe"
  ${OrIf} ${FileExists} "$PROGRAMFILES32\LibreOffice\program\soffice.exe"
    Goto bp_lo_done
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Bible Presenter uses LibreOffice (free) to show PowerPoint (.pptx) presentations exactly as designed. PDF files work without it.$\r$\n$\r$\nOpen the LibreOffice download page now?$\r$\nYou can also install it later: everything except PowerPoint import works without it." \
    /SD IDNO IDNO bp_lo_done
  ExecShell "open" "https://www.libreoffice.org/download/download-libreoffice/"
  bp_lo_done:
!macroend
