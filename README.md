# Mockup Studio

Editor de design em canvas (artboards/frames), voltado para IA, com um servidor MCP que faz tudo o que a interface faz. Local, offline-first, sem conta.

Quando você pede um mockup a um agente (Claude Code, Codex), ele usa o app via MCP para criar, ver (screenshot) e editar o design. O documento é HTML e CSS reais em um arquivo JSON legível (`*.mockup.json`).

## Recursos

- Canvas com frames (artboards), camadas, propriedades, páginas, undo/redo.
- HTML e CSS reais em `*.mockup.json`, com tokens como variáveis CSS.
- MCP completo, com 45 ferramentas: tudo o que o editor faz, mais screenshot, medidas, imagens, ícones e fontes.
- Screenshot dos nós via Electron, para o agente ver e iterar.
- Exportação para html, tailwind, react, svg, png e jpg.
- Offline, sem conta, uso local.

![Editor do Mockup Studio](docs/img/editor.png)

## Status

MVP concluído: monorepo, core, daemon, MCP, editor visual, app desktop (Electron) com render e empacotamento, CLI com `doctor` e `setup`, integração com agentes. O QA ponta a ponta com um mockup de 3 telas (`docs/qa/mvp-e2e.md`) ainda não foi feito. Plano em [docs/PLANO.md](docs/PLANO.md).

## Instalação

**Instalador (Windows).** `npm run dist` gera `dist/MockupStudio-Setup-<versão>-x64.exe`. A instalação é por usuário e registra o CLI `mockup` no PATH (abra um terminal novo depois). Também sai uma versão portátil.

**A partir do código.** Requisitos: Node 24 e npm 11.

```bash
npm install
npm run build
npm link -w @mockup/cli     # cria o comando `mockup`
```

Para desfazer: `npm unlink -g @mockup/cli`.

## Registrar no agente

```bash
mockup doctor            # diagnóstico e comandos de registro
mockup setup all         # registra no Claude Code e no Codex
claude mcp add --scope user mockup-studio -- mockup mcp   # ou o comando manual
```

Codex: `codex mcp add mockup-studio -- mockup mcp`. Detalhes, HTTP, Cursor, VS Code, Windows e solução de problemas em [docs/INTEGRACAO.md](docs/INTEGRACAO.md).

## Uso rápido

- Peça ao agente: "crie um mockup de uma landing page para um app de finanças, com versões desktop e mobile". Ele cria os frames, confere os screenshots e itera.
- Abra o editor para ver e ajustar: o app desktop ou `npm run dev` (editor em http://localhost:5173, daemon em `http://127.0.0.1:4747`). Use **Arquivo › Abrir…** ou, no terminal, `mockup open examples/landing.mockup.json`.
- Comandos do CLI: `mockup mcp` (stdio para agentes), `mockup serve [--port N] [--render]`, `mockup open`, `mockup new`, `mockup stop`, `mockup doctor`, `mockup setup`, `mockup --version`.

Guia do editor, atalhos e medições de desempenho em [docs/EDITOR.md](docs/EDITOR.md).

## Desenvolvimento

```bash
npm install
npm run build
npm run dev
```

`npm run dev` sobe o daemon em `http://127.0.0.1:4747` e o editor em http://localhost:5173. Nenhum documento é aberto automaticamente.

## App desktop (Electron)

O app desktop abre o editor numa janela nativa (menu em português, diálogos de abrir/salvar), embute o daemon (HTTP, WebSocket e MCP na mesma porta 4747) e o motor de render que gera screenshots PNG/JPG dos nós.

```bash
npm run build                          # core, server, cli, editor e desktop
npm start -w @mockup/desktop           # janela do editor
npm start -w @mockup/desktop -- --headless --port 4747   # sem janela (só daemon + render)
npm start -w @mockup/desktop -- caminho/arquivo.mockup.json   # abre o arquivo
```

- **Headless:** `--headless`, `--port N`, `--data-dir D`. Uma segunda execução repassa os arquivos à instância existente (e abre a janela, se for o caso). Ao fechar a janela com agentes MCP conectados, o app continua rodando sem janela.
- **`mockup mcp` e o Electron:** sem daemon vivo, o CLI sobe o Electron headless (variável `MOCKUP_DESKTOP_EXE`, instalação padrão em `%LOCALAPPDATA%\Programs\Mockup Studio` ou o pacote do monorepo) e o screenshot fica disponível. Sem Electron, cai para o daemon Node (sem screenshot). `MOCKUP_NO_ELECTRON=1` força o daemon Node. Se já houver um daemon Node headless (sem screenshot) iniciado pelo CLI, ele é trocado pelo Electron headless com os mesmos documentos abertos; um `mockup serve` seu não é derrubado (o CLI avisa). `mockup stop` encerra o daemon descoberto (o app com janela recusa: feche-o pela janela). `MOCKUP_DATA_DIR` só é repassada ao app se você a definiu. `mockup serve --render` roda o Electron headless em primeiro plano; `mockup serve` (Node) também serve o editor em `http://127.0.0.1:4747/` se o editor estiver buildado.
- **Render por HTTP:** `GET /render/<docId>/<nodeId>.png?scale=1|2|3&transparent=1`, `.jpg?quality=90` e `.svg`.
- **Empacotar:** `npm run dist` (da raiz, depois do build) gera em `dist/` o instalador NSIS (`MockupStudio-Setup-*.exe`, por usuário, com escolha de pasta) e a versão portátil (`MockupStudio-Portable-*.exe`), além de `dist/win-unpacked/`. Sem assinatura de código.
- **Associação de arquivo (Windows):** o Windows só enxerga a última extensão de `.mockup.json` (`.json`), então o instalador NÃO assume `.json`. Ele registra o ProgID `MockupStudio.Document` e o lista em "Abrir com" dos arquivos `.json`; o app abre o arquivo recebido no argumento. Ícones: `npm run icons -w @mockup/desktop`.

Detalhes de arquitetura em [packages/desktop/README.md](packages/desktop/README.md).

## Testes

```bash
npm test                     # unitários (Vitest) de todos os pacotes
npx playwright install chromium   # uma vez
npm run test:e2e             # e2e do editor (Playwright)
npm run screenshot           # regenera docs/img/editor.png
npm run lint
```

## Estrutura do repositório

```
packages/
  core/      @mockup/core    modelo, ops, History, HTML <-> nós, exportadores, schema zod
  server/    @mockup/server  daemon: documentos, HTTP, WebSocket, MCP
  cli/       @mockup/cli     comando `mockup` (mcp, serve, open, new, stop, doctor, setup)
  editor/    @mockup/editor  Vite + React 19 + zustand: editor visual (e2e em editor/e2e)
  desktop/   @mockup/desktop shell Electron, motor de render e empacotamento
docs/        PLANO, ARQUITETURA, MCP, EDITOR, EXPORT, INTEGRACAO
integrations/ skill do Claude Code e trecho de AGENTS.md para o Codex
examples/    documentos de exemplo
```

## Documentação

- [docs/PLANO.md](docs/PLANO.md): escopo do MVP e fases seguintes
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): pacotes, formato de arquivo, ops, protocolo WS, HTTP
- [docs/MCP.md](docs/MCP.md): conexão, convenções e ferramentas
- [docs/EDITOR.md](docs/EDITOR.md): uso do editor, atalhos, painéis e desempenho
- [docs/EXPORT.md](docs/EXPORT.md): exportadores html, tailwind, react e svg
- [docs/INTEGRACAO.md](docs/INTEGRACAO.md): registro no Claude Code, Codex e outros clientes
- [packages/desktop/README.md](packages/desktop/README.md): app Electron, render e empacotamento

## Roadmap

Fases seguintes em [docs/PLANO.md](docs/PLANO.md), uma branch por fase:

- Fase 2: tokens com grupos e temas em CSS real.
- Fase 3: classes Tailwind no modelo.
- Fase 4: componentes.
- Fase 5: snapshots e versões.
- Fase 6: assets.
- Fase 7: vetores e grid.
- Fase 8: efeitos e embeds.
- Fase 9: assistente de IA no editor.

## Licença

MIT. Veja [LICENSE](LICENSE).
