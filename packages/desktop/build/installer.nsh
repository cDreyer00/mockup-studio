; Associação de arquivos do Mockup Studio.
; O Windows só enxerga a última extensão de "nome.mockup.json" (".json"), então NÃO tomamos
; ".json" como padrão: registramos um ProgID próprio e o listamos em "Abrir com" de .json.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document" "" "Documento do Mockup Studio"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\shell\open" "" "Abrir no Mockup Studio"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.json\OpenWithProgids" "MockupStudio.Document" ""
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Classes\.json\OpenWithProgids" "MockupStudio.Document"
  DeleteRegKey HKCU "Software\Classes\MockupStudio.Document"
!macroend
