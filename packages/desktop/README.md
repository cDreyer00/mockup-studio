# @mockup/desktop

Shell desktop (Electron) do Mockup Studio. Chega na **tarefa 3** do MVP; nesta etapa o pacote contém apenas este README.

## Papel

- **Shell desktop:** janela com o editor, daemon rodando in-process, menu nativo, diálogos de abrir/salvar arquivo e associação de arquivos `.mockup.json`.
- **Motor de render/screenshot:** `RenderService` com uma `BrowserWindow` offscreen e `webContents.capturePage`, com `deviceScaleFactor` de 1 a 3 e cache por hash do conteúdo. É usado pelas rotas HTTP `GET /render/:docId/:nodeId.png|svg` e pela ferramenta MCP `get_screenshot`.
- **Modo `--headless`:** sobe o daemon e o motor de render sem janela visível. O comando `mockup mcp` usa esse modo e, se o Electron não estiver disponível, cai para o daemon Node.

## Planejado

- Build com electron-vite e electron-builder.
- `npm run dist`: instalador NSIS e versão portátil.
- Ícone próprio.

## Referências

- [docs/PLANO.md](../../docs/PLANO.md) (tarefa 3)
- [docs/ARQUITETURA.md](../../docs/ARQUITETURA.md)
