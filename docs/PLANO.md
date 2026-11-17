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

### Tarefa 2 — Editor visual completo (concluída)

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

Resultado: tudo acima entregue (ver [EDITOR.md](EDITOR.md)). Medição com 300 nós: `applyOp` < 1 ms, `doc:changed` completo < 1 ms para serializar e integrar, latência MCP → canvas ~31 ms, arrasto a 60 fps; a clonagem por JSON e o documento completo no WS foram mantidos. Decisões: zustand para os stores; op `setTag` (com ferramenta MCP `set_tag`); `history` (`canUndo`/`canRedo`) nos eventos; `doc:new`/`doc:close` no WS; `POST /api/assets/:docId` e `GET /api/recent`.

Pendências herdadas da tarefa 2 que seguem abertas (as de diálogos nativos, "Salvar como" e troca de `src` foram atendidas na tarefa 3):

- Op para o fundo da página (`page.background`): o fundo ainda não tem op nem controle no painel.
- Canvas: marquee com Ctrl para selecionar filhos de um frame; arrastar no canvas para mudar o pai (hoje só pelas camadas); seleção mista (livres + em fluxo) move só os livres; pai `grid` tratado como bloco vertical na reordenação.
- Texto criado fora de um frame mostra um aviso em vez de criar um frame.

### Tarefa 3 — Electron, screenshot e exportação (concluída)

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

Resultado: tudo acima entregue (ver [ARQUITETURA.md](ARQUITETURA.md), [EXPORT.md](EXPORT.md), [MCP.md](MCP.md) e o [README do desktop](../packages/desktop/README.md)).

- App Electron 45 com o daemon in-process, o `RenderService` (janela oculta em `/render.html`, captura via CDP `Page.captureScreenshot`, escala 1 a 3, JPG e `maxWidth` por `nativeImage`, cache LRU por hash, fila serial e recuperação da janela), menu nativo, diálogos de abrir/salvar, "Salvar como" (`doc:saveAs`, Ctrl+Shift+S) e modo `--headless`. `mockup mcp` sobe o Electron headless e cai para o daemon Node (sem screenshot); `mockup serve --render` roda o Electron em primeiro plano.
- `npm run dist` gera o instalador NSIS (por usuário) e o portátil em `dist/`; associação de `.mockup.json` por ProgID em `OpenWithProgids` (o Windows só vê a última extensão).
- Exportadores html, tailwind (v4), react (Tailwind ou inline) e svg (com layout medido ou `<foreignObject>`), com snapshots. CSS base único do documento (`base.ts`): o mesmo no canvas, no render e no código exportado; o CSS da interface não vaza no design.
- MCP: `get_screenshot`, `get_layout`, `export`, `get_code`, `insert_image`, `insert_icon`, `search_icons`, `list_fonts`, `get_font_info`, `add_font`, `finish_working`, e os guias `screenshot-loop` e `export`. Ops novas `setFonts` e `setSrc`; evento `agent:finished`; rotas `GET /render/:docId/:nodeId.(png|jpg|svg)`; editor estático em `/`; `render` no `/api/health`.
- Pendências herdadas da tarefa 1 resolvidas: o WebSocket não aceita mais `Origin` `file://` (o app serve o editor do próprio daemon); valores de `style` que escapam da declaração são recusados na edição e descartados na leitura e no export; tokens ganham o prefixo `--` automaticamente. Segue em aberto só o `allowedHosts` do MCP, que não inclui o host de bind (só importa se o daemon deixar de escutar em 127.0.0.1).

Pendências herdadas para a tarefa 4:

- O menu nativo e os diálogos do app não são exercitados em teste automatizado de UI.
- O cache de render não invalida se um arquivo de `assets/` for trocado mantendo o nome.
- O instalador NSIS é gerado, mas a instalação e a associação de arquivo não foram testadas numa máquina limpa; sem assinatura de código.
- `add_font` com `google` só baixa o estilo normal e o subconjunto latin, e não foi testado contra a internet.
- O Tailwind exportado só foi validado num projeto Vite com `@tailwindcss/vite`; outros bundlers não foram testados.
- SVG com layout ignora `transform`, sombras múltiplas e gradientes não lineares.
- `insert_image` usa o tamanho intrínseco, sem limitar ao do pai.
- O daemon headless (Electron) iniciado pelo `mockup mcp` continua rodando até ser encerrado (como o daemon Node).

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
- **QA e2e** com mockup real de 3 telas, registrado em [qa/mvp-e2e.md](qa/mvp-e2e.md) (concluído em 16/11/2026).
- README final com licença MIT.

Resultado (integração; o QA e2e foi feito depois, veja [qa/mvp-e2e.md](qa/mvp-e2e.md)):

- CLI: `npm link -w @mockup/cli` expõe `mockup`; `mockup doctor [--json]` (Node, pasta de dados, daemon, modo e render, porta, Electron, fontes, `mockup`/`claude`/`codex` no PATH e registro) com os comandos de registro preenchidos; `mockup setup claude|codex|all [--http] [--skill] [--print] [--command path|shim|absolute]`, idempotente; `mockup install-cli`/`uninstall-cli` (shim `mockup.cmd` e PATH do usuário pelo registro, preservando `%VAR%`); `mockup --version`.
- App empacotado: CLI e daemon Node em `resources/cli` (bundle esbuild, rodam com `ELECTRON_RUN_AS_NODE=1`), `integrations/` em `resources/integrations`; o NSIS roda `install-cli` na instalação e `uninstall-cli` na desinstalação (não na atualização); `--install-cli`/`--uninstall-cli` no próprio exe.
- MCP: `instructions` do servidor; guias `getting-started` (6 passos), `design-system` (absorve `tokens`), `layout`, `responsive` (Mobile/Tablet/Desktop), `screenshot-loop`, `export`, `troubleshooting` e `setup`, também como `guide://<topic>`; descrições de todas as ferramentas revisadas, com exemplos; erros de parâmetro em português por campo, com exemplo de chamada, e sugestão para ferramenta inexistente.
- `docs/INTEGRACAO.md`, `integrations/claude-code/SKILL.md`, `integrations/codex/AGENTS.snippet.md`, README final e `LICENSE` (MIT).
- Verificado no Windows: Claude Code 2.1.319 e Codex 0.163.0 iniciam `mockup mcp` pelo shim `.cmd` do npm (sem `cmd /c`); `claude mcp list` mostra `mockup-studio` conectado e o Codex chama as ferramentas.

Pendências:

- ~~QA e2e com mockup real de 3 telas~~: concluído em 16/11/2026, relatório em [qa/mvp-e2e.md](qa/mvp-e2e.md).
- O instalador NSIS não foi executado numa máquina (só compilado); hooks de PATH testados pelo `--install-cli`/`--uninstall-cli` do `win-unpacked` com pasta temporária.
- Se o `uninstall-cli` falhar na desinstalação, o fallback em NSIS apaga o shim mas a entrada no PATH fica (inofensiva).

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

Entregue na branch `feature/assets-dados` (assets com link direto, imagem, dados reais e organização; ver [ASSETS.md](ASSETS.md) e [DADOS.md](DADOS.md)):

- **Assets**: CDN local endereçado por conteúdo (`/cdn/<hash>.<ext>`, estável entre documentos e reinícios), biblioteca global, listagem com usos, remover não usados, otimização com sharp (opcional), aba Assets no editor. MCP: `list_assets`, `upload_asset`, `get_asset_url`, `optimize_assets`, `remove_unused_assets`.
- **Imagens**: seção Imagem (fit, posição, filtros, máscara `clip-path`), recorte visual com alças (`object-view-box`) e placeholders SVG determinísticos. MCP: `set_image`, `generate_placeholder`.
- **Dados reais**: nó `repeater` com `data` e bindings `{{campo}}`, op `setData`, expansão no canvas, render, screenshot e export; JSON/CSV/URL com origem guardada e atualização manual; seção Dados com tabela editável. MCP: `bind_data`, `refresh_data`, `get_data`.
- **Organização**: `files.json` com pastas virtuais, tags e favoritos, tela inicial com miniaturas e busca por nome/tag/conteúdo, busca de nós. MCP: `list_files`, `search_nodes`, `tag_file`, `manage_folders`, `move_files`.
- Guias `assets` e `data`.

Pendências: otimização indisponível no app empacotado (sharp fica fora do bundle); recorte com `object-view-box` só aparece no Chromium (o código exportado mostra a imagem inteira em Firefox/Safari); miniaturas de documentos fechados sem as fontes embutidas; estilos não aceitam bindings; importação em lote e SVG inline editável seguem abertos.

### Fase 7 — Vetores e grid

- Desenho vetorial básico: pen, formas, operações booleanas.
- Grids e colunas, guias e snapping.

### Fase 8 — Efeitos e embeds

- Filtros, máscaras, blend modes.
- Embeds (vídeo, iframe, Lottie) e animações simples.

### Fase 9 — Assistente de IA no editor

- Chat lateral usando as mesmas ferramentas do MCP.
- Sugestões de layout e variações.
