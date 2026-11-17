; Hooks do instalador NSIS do Mockup Studio (incluído por electron-builder.yml > nsis.include).
;
; 1) Associação de arquivos: o Windows só enxerga a última extensão de "nome.mockup.json" (".json"),
;    então NÃO tomamos ".json" como padrão: registramos um ProgID próprio e o listamos em "Abrir com".
;
; 2) CLI embutido: o instalador roda o bundle do CLI (resources\cli\mockup.mjs) com o próprio
;    executável do app como Node (ELECTRON_RUN_AS_NODE=1; o usuário não tem Node). `install-cli`
;    escreve %LOCALAPPDATA%\MockupStudio\bin\mockup.cmd e acrescenta essa pasta ao PATH do usuário;
;    `uninstall-cli` desfaz as duas coisas. A variável ELECTRON_RUN_AS_NODE é definida só durante
;    cada chamada e REMOVIDA logo depois: o "Executar Mockup Studio" do fim da instalação herda o
;    ambiente do instalador e abriria como Node se ela continuasse definida.
;
; Ordem na instalação (installSection.nsh): copia os arquivos -> customInstall (associação de
; arquivo, depois install-cli). Ordem na desinstalação (uninstaller.nsh): customUnInstall roda
; ANTES de apagar $INSTDIR (o exe e o bundle ainda existem) -> remove os arquivos. Numa atualização
; por cima o instalador novo chama o desinstalador antigo com --updated: aí NÃO desfazemos o CLI
; (o customInstall seguinte o reinstala, e o PATH nunca fica sem a pasta nem é reescrito à toa).
; Se o uninstall-cli falhar (bundle ausente, versão antiga), o fallback em NSIS puro apaga o
; mockup.cmd e a pasta se vazia; PENDÊNCIA: nesse caso a entrada no PATH do usuário fica para trás
; (inofensiva: aponta para uma pasta inexistente); `mockup uninstall-cli`/--uninstall-cli a limpa.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document" "" "Mockup Studio Document"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\shell\open" "" "Open in Mockup Studio"
  WriteRegStr HKCU "Software\Classes\MockupStudio.Document\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.json\OpenWithProgids" "MockupStudio.Document" ""

  ; CLI embutido (falha não aborta a instalação)
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\cli\mockup.mjs" install-cli --quiet'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
  DetailPrint "install-cli finished with code $0"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Classes\.json\OpenWithProgids" "MockupStudio.Document"
  DeleteRegKey HKCU "Software\Classes\MockupStudio.Document"

  ; CLI embutido: só na desinstalação de verdade (em atualização o customInstall o refaz)
  ${ifNot} ${isUpdated}
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\cli\mockup.mjs" uninstall-cli --quiet'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
    DetailPrint "uninstall-cli finished with code $0"
    ; fallback mínimo em NSIS puro (não mexe no PATH)
    Delete "$LOCALAPPDATA\MockupStudio\bin\mockup.cmd"
    RMDir "$LOCALAPPDATA\MockupStudio\bin"
    RMDir "$LOCALAPPDATA\MockupStudio"
  ${endIf}
!macroend
