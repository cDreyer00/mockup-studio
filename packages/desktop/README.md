# @mockup/desktop

App desktop (Electron) do Mockup Studio: janela do editor, daemon embutido, motor de render/screenshot e modo headless.

## Como rodar

```bash
npm run build                                   # na raiz (precisa de core, server e editor buildados)
npm start -w @mockup/desktop                    # janela
npm start -w @mockup/desktop -- --headless --port 4747 --data-dir D:\dados arquivo.mockup.json
npm test -w @mockup/desktop                     # unitários + integração real com o Electron headless
npm run dist                                    # raiz: build + instalador NSIS e portátil em dist/
npm run icons -w @mockup/desktop                # regenera build/icon.png e build/icon.ico a partir de build/icon.svg
```

## Arquitetura

- **Build:** electron-vite. O processo principal sai em ESM (`out/main/index.js`) com TODAS as dependências embutidas (server, core, express, ws, MCP SDK, zod...); só `electron` é externo, então o pacote final não leva `node_modules`. O preload sai em CJS (`out/preload/index.cjs`, exigência do sandbox). Não há build de renderer: o editor vem de `packages/editor/dist` (em dev) ou de `resources/editor` (empacotado, via `extraResources`, junto de `resources/docs`).
- **Processo principal** (`src/main/index.ts`): sobe `startDaemon({ render, editorDir, openFiles, writeInfo: true })` em processo (porta 4747, mesmo `daemon.json` do CLI) e abre uma `BrowserWindow` em `http://127.0.0.1:<porta>/` (`contextIsolation`, `sandbox`, sem `nodeIntegration`; navegação para outras origens bloqueada, links http(s) vão ao navegador). Instância única (`requestSingleInstanceLock`): uma segunda execução repassa os arquivos e abre a janela. Se a porta já tem um daemon do Mockup Studio sem render (Node), o app pede `POST /api/shutdown`, espera a porta liberar, sobe o próprio daemon e reabre os documentos do outro e os do argv. Se o outro tem render (outra instância Electron), a janela usa esse daemon; no headless o app sai com código 1. Com `--headless`, `POST /api/shutdown` (`mockup stop`) encerra o app; com janela, responde 409.
- **Ciclo de vida:** headless não tem janela e não encerra por `window-all-closed`. Em modo janela, ao fechar a última janela o app segue headless se houver sessões MCP ativas (verificação a cada 5 s) e encerra quando elas zerarem; sem sessões, encerra na hora. `before-quit` fecha o daemon (salva pendentes) e o render. Só com `--data-dir` ou `MOCKUP_DATA_DIR` definida pelo usuário antes de iniciar (o CLI não a força) o `userData` do Electron fica em `<pasta>/electron`, o que isola o lock de instância única.
- **Menu** (`src/main/menu.ts`): Arquivo, Editar, Ver e Ajuda em português. Atalhos que o editor já trata no teclado (Ctrl+S, Ctrl+Shift+S, Ctrl+Z, Ctrl+Shift+Z, `-`, Shift+Plus, Shift+0, Shift+1) são só exibidos (`registerAccelerator: false`) para não disparar duas vezes. A lista "Abrir recente" vem de `recent.json` e é refeita ao focar a janela e quando o editor informa mudança de estado.

### Ponte do editor (preload e IPC)

`window.mockupDesktop` só existe quando a página vem de `127.0.0.1`/`localhost`:

| API                                        | Canal IPC                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `showOpenDialog()`                         | `desktop:openDialog` (invoke)                                                                                 |
| `showSaveDialog({ title?, defaultPath? })` | `desktop:saveDialog` (invoke); o caminho volta terminado em `.mockup.json`                                    |
| `onMenu(cb)`                               | `desktop:menu` (main → renderer)                                                                              |
| `setDocumentState({ title, path, dirty })` | `desktop:docState` (send); título da janela com `•` quando sujo, `setRepresentedFilename`/`setDocumentEdited` |

Ações do menu: `new`, `open`, `openRecent` (com o caminho em `arg`), `save`, `saveAs`, `close`, `undo`, `redo`, `zoomIn`, `zoomOut`, `zoomReset`, `zoomFit`. Os handlers IPC conferem que o frame remetente é da origem do daemon.

## RenderService (`src/main/render.ts`)

Implementa `RenderProvider` (`capture` e `measure`) do `@mockup/server`.

- Uma `BrowserWindow` reutilizável (sandbox, sem preload) carrega `/render.html` e espera `window.__mockupRenderReady === true`. É recriada se o processo de render morrer (`render-process-gone`) ou travar (timeout de 30 s por operação). Operações entram numa fila serial.
- **Contrato da página de render:** `window.__mockupRender.render({ doc, docId, nodeId, transparent? })` devolve `RenderBox { frameId, frameWidth, frameHeight, x, y, width, height }` (o frame do nó é renderizado em 0,0; x/y/width/height é o retângulo do nó relativo ao frame, em px CSS) e `window.__mockupRender.measure(nodeId)` devolve o `LayoutNode`.
- **Captura via CDP** (`webContents.debugger`, protocolo 1.3): `Emulation.setDeviceMetricsOverride` com viewport ≥ frame (largura/altura declaradas no estilo ou, se faltarem, medida por um primeiro render, repetindo o render quando a viewport cresce) e `deviceScaleFactor = scale`; fundo alfa 0 com `transparent`; depois `Page.captureScreenshot` com `clip` do nó. Se o CDP falhar, usa `capturePage` como alternativa (ignora a escala).
- Limite de 16384 px por lado após a escala (erro claro). JPG: `nativeImage.toJPEG(quality ?? 90)`. `maxWidth`: `nativeImage.resize` com qualidade `best`.
- Cache LRU de 256 MB (por bytes) por sha256 de `{ frame do nó, tokens, fontes, fundo da página, docId, nodeId, scale, format, quality, maxWidth, transparent, tamanho e data dos arquivos referenciados }` (imagens, `url()` relativos e fontes em `assets/`): trocar um arquivo mantendo o nome invalida o cache.
- A viewport (`frame × scale`) é validada contra 16384 px por lado antes de redimensionar a janela. A janela de render nega `will-navigate` e `window.open`.
- **Janela "visível" fora da tela:** com a janela realmente oculta (`show: false` sem nunca exibir) o renderer do Chromium cai em `Page.captureScreenshot` no Windows. Por isso a janela de render é criada sem moldura, transparente, sem foco, fora da barra de tarefas e posicionada fora da tela, e recebe `showInactive()`.
- `MOCKUP_RENDER_DEBUG=1` loga os comandos CDP; `MOCKUP_DISABLE_GPU=1` desliga a aceleração por GPU no headless.

## Empacotamento (`electron-builder.yml`)

Saída em `dist/` na raiz do repositório. Alvos Windows: `nsis` (assistente, por usuário, escolha de pasta; instala em `%LOCALAPPDATA%\Programs\Mockup Studio`) e `portable`. O Electron usado vem de `node_modules/electron/dist` (`electronDist`, versão fixa no yml porque o pacote declara um intervalo). Sem assinatura de código.

**Associação de arquivo:** o Windows só enxerga a última extensão de `*.mockup.json` (`.json`). Registrar `.json` como padrão sequestraria todos os JSON, então `build/installer.nsh` cria o ProgID `MockupStudio.Document` (comando `"<exe>" "%1"`) e o inclui em `HKCU\Software\Classes\.json\OpenWithProgids`, o que o faz aparecer em "Abrir com". O desinstalador remove as chaves. O app abre o arquivo recebido no argv.

## CLI embutido

O pacote leva o CLI `mockup` para quem não tem Node. O `scripts/build-cli.mjs` (esbuild, parte de `npm run build -w @mockup/desktop`) gera `out/cli/mockup.mjs` e `out/cli/daemon.mjs` (ESM, alvo node22, tudo embutido) a partir de `packages/cli/dist/bin.js` e `packages/server/dist/bin.js`; por isso cli e server precisam estar buildados antes. Eles vão para `resources/cli/` (`extraResources`, fora do asar), junto de `resources/integrations/`. Rodam com o próprio executável como Node: `ELECTRON_RUN_AS_NODE=1 "Mockup Studio.exe" resources\cli\mockup.mjs help`.

- **Instalador NSIS** (`build/installer.nsh`): ao instalar roda `install-cli --quiet`, que cria `%LOCALAPPDATA%\MockupStudio\bin\mockup.cmd` e acrescenta a pasta ao PATH do usuário (vale em terminais novos). Ao desinstalar roda `uninstall-cli --quiet` (antes de apagar os arquivos); numa atualização por cima o CLI é só reinstalado. `ELECTRON_RUN_AS_NODE` é definida apenas durante cada chamada.
- **Reparo:** `"Mockup Studio.exe" --install-cli [--bin-dir D] [--quiet]` e `--uninstall-cli` rodam o mesmo comando e saem com o código dele, sem janela nem daemon.
- **Portátil:** não registra o CLI. O executável se extrai numa pasta temporária a cada execução, então um `mockup.cmd` apontando para ela quebraria quando o app fechasse; `--install-cli` recusa com uma mensagem (detecta `PORTABLE_EXECUTABLE_DIR`). Para usar o `mockup` com o portátil, instale o CLI pelo Node (`npm link`) e aponte `MOCKUP_DESKTOP_EXE` para o executável portátil se quiser screenshot.
- **Desfazer manualmente:** `--uninstall-cli` (ou `mockup uninstall-cli`); se o desinstalador não conseguir limpar o PATH, a entrada fica apontando para uma pasta inexistente (inofensiva).

## Referências

- [docs/PLANO.md](../../docs/PLANO.md) (tarefa 3)
- [docs/ARQUITETURA.md](../../docs/ARQUITETURA.md)
