# Plano do Mockup Studio

Editor de design em canvas voltado para IA, com servidor MCP que cobre tudo o que a interface faz. Uso pessoal, local, offline-first, sem conta. Prioridade máxima: quando o usuário pede um mockup a um agente, o agente usa o app via MCP para criar, ver (screenshot) e editar o design.

## MVP (branch `feature/mvp`)

### Tarefa 1 — Fundação (concluída)

- Monorepo (npm workspaces, ESM, TypeScript, Vitest).
- `core`: modelo, ops com inverso, `History`, HTML <-> nós, resumo da árvore, schema zod.
- Daemon: documentos abertos, HTTP, WebSocket, MCP (Streamable HTTP), autosave.
- CLI: `mockup mcp | serve | open | new`.
- MCP básico: leitura e escrita de documentos, nós, estilos, tokens, seleção, undo/redo.
- Scaffold do editor como visualizador somente leitura.
- Documentação inicial.

### Tarefa 2 — Editor visual completo

- **Canvas infinito**
  - Zoom: Ctrl+roda, pinch, `+`, `-`, `Shift+0`, `Shift+1`, `Shift+2`.
  - Pan: espaço, botão do meio, roda.
- **Seleção**
  - Clique, Shift, marquee.
  - Duplo clique entra no nó; Esc sobe um nível.
  - Alças, hover e régua de distâncias com Alt.
- **Mover**
  - Frames no canvas.
  - Reordenar em contêiner flex, com indicador.
  - `x`/`y` em filhos absolute.
  - Setas: 1 px; com Shift: 10 px.
- **Redimensionar**
  - Alças; Alt redimensiona pelo centro; Shift mantém proporção.
  - Modos auto, 100% e fill.
- **Ferramentas**: Frame (F), Container (R), Texto (T), Imagem (upload para `assets/`).
- **Texto**: edição inline.
- **Painel de camadas**
  - Árvore, arrastar para mudar o pai, renomear, ocultar, travar.
  - Menu de contexto: duplicar, excluir, agrupar, desagrupar, ordem.
- **Painel de propriedades**
  - Posição e tamanho, layout flex, tipografia, aparência, efeitos, tag/atributos, nome.
  - Inputs com arrastar e unidades; CSS avançado.
- **Páginas**.
- **Undo/redo** via daemon.
- **Clipboard** interno e colar HTML externo.
- **Seleção sincronizada** com o MCP; badge "agente trabalhando".
- **Arquivo**: abrir, novo, salvar, recentes, indicador de não salvo.
- **Desempenho** com 300 nós. Pendências herdadas da tarefa 1: `applyOp` faz cópia profunda do documento via JSON a cada op, e `doc:changed` envia o documento completo pelo WebSocket a cada mudança. Medir com 300 nós e, se preciso, trocar por clonagem estrutural (`structuredClone`/cópia por caminho) e por deltas de ops no WS.
- **Qualidade**: testes Vitest, 5 testes e2e com Playwright, `docs/EDITOR.md`, screenshot no README.

### Tarefa 3 — Electron, screenshot e exportação

- **`packages/desktop`**
  - electron-vite e electron-builder; daemon in-process; menu nativo; diálogos; associação `.mockup.json`; ícone próprio.
  - Modo `--headless`; `mockup mcp` sobe Electron headless com fallback para o daemon Node.
  - `npm run dist`: NSIS e portátil.
- **`RenderService`**
  - `BrowserWindow` offscreen, página de render, fontes e assets, `deviceScaleFactor` 1 a 3, `capturePage`, cache por hash.
  - JPG via `nativeImage`; SVG via exportador do core e `measure(nodeId)`.
  - Rotas `GET /render/:docId/:nodeId.png|svg`.
- **Exportadores** em `packages/core/src/export`, com snapshots:
  - html: classes por slug, tokens em `:root`.
  - tailwind: v4, classes idiomáticas, valores arbitrários `[...]`.
  - react: TSX, `className` Tailwind ou inline, PascalCase, extração de repetições em `map`.
- **MCP novo**
  - `get_screenshot(nodeId?, scale?, format?, maxWidth?)`, `get_layout(nodeId, depth?)`.
  - `export(nodeIds[], format, scale?, outputDir?)`, `get_code(nodeId, format, styles?)`.
  - `insert_image`, `insert_icon` (Lucide via `lucide-static`), `search_icons`.
  - `list_fonts`, `get_font_info`, `add_font` (offline-first).
  - `finish_working`.
  - Guias `screenshot-loop` e `export`.
- `docs/EXPORT.md`.

### Tarefa 4 — Integração com agentes e QA ponta a ponta

- **Instalação do CLI**: `npm link`, `mockup.cmd` em `%LOCALAPPDATA%\MockupStudio\bin` pelo instalador, `mockup doctor`.
- **`docs/INTEGRACAO.md`**
  - Claude Code: `claude mcp add --scope user mockup-studio -- mockup mcp` e variante HTTP.
  - Codex: `codex mcp add mockup-studio -- mockup mcp` e `config.toml`.
  - JSON `mcpServers` para Cursor, VS Code e Claude Desktop.
  - `mockup setup claude|codex|all`.
- **Guias no MCP**: `getting-started` (6 passos), `design-system`, `responsive`, `screenshot-loop`, `export`, `troubleshooting`, `setup`.
- Revisão das descrições de todas as ferramentas.
- `integrations/claude-code/SKILL.md` e `integrations/codex/AGENTS.snippet.md`.
- **QA e2e** com mockup real de 3 telas, registrado em `docs/qa/mvp-e2e.md`.
- README final com licença MIT.

## Fases seguintes

Após o MVP, uma branch por fase.

### Fase 2 — Tokens e temas em CSS real (`feature/tokens-temas`)

- Tokens com grupos (cores, tipografia, espaçamento, raio, sombra).
- Temas: `themes: { name, overrides }`; frame com `theme`.
- Resolução de `var()`, `calc()` e `color-mix()` em `getComputedLike` e nos exportadores (HTML com `:root` e `[data-theme]`, Tailwind `@theme`, React com CSS vars).
- Validação com `css-tree` ou `lightningcss`.
- Painel de tokens no editor, com seletor de token nos inputs.
- MCP: `get_tokens` ampliado, `rename_token`, `apply_token`, `create_theme`, `set_frame_theme`, `import_tokens` (CSS `:root` e W3C Design Tokens JSON), `export_tokens(css|json|tailwind)`.
- `docs/TOKENS.md`.

### Fase 3 — Tailwind no modelo

- Aceitar classes utilitárias em `write_html` e ao colar (classe para CSS).
- Exportação Tailwind fiel e round-trip.

### Fase 4 — Componentes

- Mestres e instâncias com overrides; propriedades e variantes.
- Biblioteca por documento.
- MCP para criar, instanciar e destacar.

### Fase 5 — Snapshots e versões

- Versões nomeadas, diff visual, restaurar.

### Fase 6 — Assets

- Gerenciador de imagens, fontes e ícones.
- Otimização e importação em lote.
- SVG inline editável.

### Fase 7 — Vetores e grid

- Desenho vetorial básico: pen, formas, operações booleanas.
- Grids e colunas, guias e snapping.

### Fase 8 — Efeitos e embeds

- Filtros, máscaras, blend modes.
- Embeds (vídeo, iframe, Lottie) e animações simples.

### Fase 9 — Assistente de IA no editor

- Chat lateral usando as mesmas ferramentas do MCP.
- Sugestões de layout e variações.
