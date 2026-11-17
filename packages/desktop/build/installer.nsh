; Mockup Studio NSIS installer hooks (included by electron-builder.yml > nsis.include).
;
; 1) File association: Windows only sees the last extension of "name.mockup.json" (".json"),
;    so we do NOT claim ".json" as the default: we register our own ProgID and list it in "Open with".
;
; 2) Embedded CLI: the installer runs the CLI bundle (resources\cli\mockup.mjs) using the app's own
;    executable as Node (ELECTRON_RUN_AS_NODE=1; the user has no Node). `install-cli`
;    writes %LOCALAPPDATA%\MockupStudio\bin\mockup.cmd and appends that folder to the user's PATH;
;    `uninstall-cli` undoes both. The ELECTRON_RUN_AS_NODE variable is set only during
;    each call and REMOVED right after: the "Run Mockup Studio" step at the end of the install inherits the
;    installer's environment and would open as Node if it stayed set.
;
; Install order (installSection.nsh): copy the files -> customInstall (file association, then
; install-cli). Uninstall order (uninstaller.nsh): customUnInstall runs BEFORE $INSTDIR is
; deleted (the exe and the bundle still exist) -> remove the files. On an in-place update the new
; installer calls the old uninstaller with --updated: then we do NOT undo the CLI (the following
; customInstall reinstalls it, and PATH never loses the folder nor gets rewritten needlessly).
; If uninstall-cli fails (missing bundle, old version), the plain-NSIS fallback deletes
; mockup.cmd and the folder if empty; KNOWN ISSUE: in that case the entry in the user's PATH is left behind
; (harmless: it points to a nonexistent folder); `mockup uninstall-cli`/--uninstall-cli cleans it.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document" "" "Mockup Studio Document"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\shell\open" "" "Open in Mockup Studio"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.json\OpenWithProgids" "MockupStudio.Document" ""

  ; Embedded CLI (failure does not abort the install)
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\cli\mockup.mjs" install-cli --quiet'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
  DetailPrint "install-cli finished with code $0"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Classes\.json\OpenWithProgids" "MockupStudio.Document"
  DeleteRegKey HKCU "Software\Classes\MockupStudio.Document"

  ; Embedded CLI: only on a real uninstall (on update customInstall redoes it)
  ${ifNot} ${isUpdated}
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\cli\mockup.mjs" uninstall-cli --quiet'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
    DetailPrint "uninstall-cli finished with code $0"
    ; minimal plain-NSIS fallback (does not touch PATH)
    Delete "$LOCALAPPDATA\MockupStudio\bin\mockup.cmd"
    RMDir "$LOCALAPPDATA\MockupStudio\bin"
    RMDir "$LOCALAPPDATA\MockupStudio"
  ${endIf}
!macroend
