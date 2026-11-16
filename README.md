# Mockup Studio

Editor de design em canvas (artboards/frames), voltado para IA, com um servidor MCP capaz de fazer tudo o que a interface faz. Uso pessoal, local, offline-first, sem conta.

Quando você pede um mockup a um agente (Claude Code, Codex), ele usa o app via MCP para criar, inspecionar e editar o design. O documento é HTML e CSS reais em um arquivo JSON legível (`*.mockup.json`).

## Status

MVP — tarefa 2/4 concluída: monorepo, core, daemon, MCP e editor visual completo (canvas, seleção, camadas, propriedades, undo/redo, clipboard, páginas).

![Editor do Mockup Studio](docs/img/editor.png)

## Requisitos

- Node 24
- npm 11

## Como rodar

```bash
npm install
npm run build
npm test
npm run dev
```

`npm run dev` sobe o daemon em `http://127.0.0.1:4747` e o editor em http://localhost:5173. Nenhum documento é aberto automaticamente: use **Arquivo › Abrir…** ou **Novo…** no editor, ou, em outro terminal:

```bash
node packages/cli/dist/bin.js open examples/landing.mockup.json
```

Ou peça ao agente para chamar a ferramenta MCP `open_document`. Guia do editor, atalhos e medições de desempenho em [docs/EDITOR.md](docs/EDITOR.md).

## Testes

```bash
npm test                     # unitários (Vitest) de todos os pacotes
npx playwright install chromium   # uma vez
npm run test:e2e             # e2e do editor (Playwright): sobe daemon e editor em portas de teste
npm run screenshot           # regenera docs/img/editor.png
npm run lint
```

## Registrar o MCP no Claude Code

Com o repositório compilado (`npm run build`):

```bash
claude mcp add mockup-studio -- node <caminho-absoluto>/packages/cli/dist/bin.js mcp
```

Depois de `npm link -w @mockup/cli` (expõe o comando `mockup`):

```bash
claude mcp add mockup-studio -- mockup mcp
```

Alternativa HTTP, com o daemon rodando:

```bash
claude mcp add --transport http mockup-studio http://127.0.0.1:4747/mcp
```

Detalhes e lista de ferramentas em [docs/MCP.md](docs/MCP.md).

## Estrutura do repositório

```
packages/
  core/      @mockup/core    modelo, ops, History, HTML <-> nós, schema zod
  server/    @mockup/server  daemon: documentos, HTTP, WebSocket, MCP
  cli/       @mockup/cli     comando `mockup` (mcp, serve, open, new)
  editor/    @mockup/editor  Vite + React 19 + zustand: editor visual (e2e em editor/e2e)
  desktop/   shell Electron e motor de render (tarefa 3)
docs/        PLANO.md, ARQUITETURA.md, MCP.md, EDITOR.md
examples/    documentos de exemplo
```

## Documentação

- [docs/PLANO.md](docs/PLANO.md): escopo do MVP e fases seguintes
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): pacotes, formato de arquivo, ops, protocolo WS, HTTP
- [docs/MCP.md](docs/MCP.md): conexão, convenções e ferramentas
- [docs/EDITOR.md](docs/EDITOR.md): uso do editor, atalhos, painéis, arquitetura interna e desempenho
