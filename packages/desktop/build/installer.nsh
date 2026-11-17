; NSIS installer hooks for Mockup Studio (included by electron-builder.yml > nsis.include).
;
; 1) File association: Windows only sees the last extension of "name.mockup.json" (".json"),
;    so we do NOT claim ".json" as the default: we register our own ProgID and list it under "Open with".
;
; 2) Bundled CLI: the installer runs the CLI bundle (resources\cli\mockup.mjs) with the app's own
;    executable as Node (ELECTRON_RUN_AS_NODE=1; the user does not have Node). `install-cli`
;    writes %LOCALAPPDATA%\MockupStudio\bin\mockup.cmd and appends that folder to the user's PATH;
;    `uninstall-cli` undoes both. The ELECTRON_RUN_AS_NODE variable is set only during
;    each call and REMOVED right after: the "Run Mockup Studio" option at the end of setup inherits the
;    installer's environment and would open as Node if it stayed set.
;
; Install order (installSection.nsh): copies the files -> customInstall (file association,
; then install-cli). Uninstall order (uninstaller.nsh): customUnInstall runs
; BEFORE $INSTDIR is deleted (the exe and bundle still exist) -> removes the files. On an update
; over an existing install the new installer calls the old uninstaller with --updated: in that case we do NOT undo the CLI
; (the following customInstall reinstalls it, and the PATH never loses the folder nor is rewritten needlessly).
; If uninstall-cli fails (missing bundle, old version), the pure-NSIS fallback deletes
; mockup.cmd and the folder if empty. TODO: in that case the user's PATH entry is left behind
; (harmless: it points to a nonexistent folder); `mockup uninstall-cli`/--uninstall-cli cleans it up.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document" "" "Mockup Studio Document"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\shell\open" "" "Open in Mockup Studio"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.json\OpenWithProgids" "MockupStudio.Document" ""

  ; Bundled CLI (a failure does not abort the install)
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\cli\mockup.mjs" install-cli --quiet'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
  DetailPrint "install-cli exited with code $0"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Classes\.json\OpenWithProgids" "MockupStudio.Document"
  DeleteRegKey HKCU "Software\Classes\MockupStudio.Document"

  ; Bundled CLI: only on a real uninstall (on update, customInstall redoes it)
  ${ifNot} ${isUpdated}
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\cli\mockup.mjs" uninstall-cli --quiet'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
    DetailPrint "uninstall-cli exited with code $0"
    ; minimal pure-NSIS fallback (does not touch the PATH)
    Delete "$LOCALAPPDATA\MockupStudio\bin\mockup.cmd"
    RMDir "$LOCALAPPDATA\MockupStudio\bin"
    RMDir "$LOCALAPPDATA\MockupStudio"
  ${endIf}
!macroend
