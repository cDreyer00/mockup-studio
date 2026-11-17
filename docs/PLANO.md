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
  - `insert_image`, `insert_icon` (Lucide via `lucide-static` e Heroicons via `@iconify-json/heroicons`, MIT), `search_icons`.
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

### Fase 2 — Tokens e temas em CSS real (`feature/design-system`, concluída)

- Tokens com grupos (cores, tipografia, espaçamento, raio, sombra).
- Temas: `themes: { name, overrides }`; frame com `theme`.
- Resolução de `var()`, `calc()` e `color-mix()` em `getComputedLike` e nos exportadores (HTML com `:root` e `[data-theme]`, Tailwind `@theme`, React com CSS vars).
- Validação com `css-tree` ou `lightningcss`.
- Painel de tokens no editor, com seletor de token nos inputs.
- MCP: `get_tokens` ampliado, `rename_token`, `apply_token`, `create_theme`, `set_frame_theme`, `import_tokens` (CSS `:root` e W3C Design Tokens JSON), `export_tokens(css|json|tailwind)`.
- `docs/TOKENS.md`.

Resultado (branch `feature/design-system`; ver [TOKENS.md](TOKENS.md)):

- Core: `tokenMeta` (grupo, descrição) e `themes` opcionais no documento (arquivos antigos continuam iguais); tema do frame no atributo `data-theme`; ops `setTokens` com `theme`, `setTokenMeta`, `setThemes`, `replaceTokens` e `renameToken` (atualiza todas as referências, undo exato). Resolução com a semântica do CSS (aliases redeclarados dentro do tema, ciclos sem valor), `calc()`/`min()`/`max()`/`clamp()` e `color-mix()` avaliados em `getComputedLike`; validação com css-tree (bundle `dist/csstree.esm`); import/export CSS, W3C Design Tokens e Tailwind v4.
- Exportadores: HTML com `:root` e `[data-theme]`, Tailwind com regras de tema e `@custom-variant theme-<nome>`, React inline com as variáveis do tema; cache de render chaveado também pelos temas.
- Editor: aba Tokens (busca, grupos, edição inline, temas, importar/exportar, avisos), "ligar a token" nos inputs, tema por frame, `background-blend-mode`.
- MCP: `get_tokens`/`set_tokens` ampliados, `rename_token`, `apply_token`, `create_theme`, `rename_theme`, `delete_theme`, `set_frame_theme`, `import_tokens`, `export_tokens`, `theme` em `get_styles` e o guia `tokens`.

Pendências: seletor de token em gradientes, `transform`, `filter` e `flex`; reordenar tokens por arrasto; o chunk do canvas cresceu (~650 kB) com css-tree e zod.

### Fase 3 — Tailwind nativo (`feature/design-system`, concluída)

- Aceitar classes utilitárias em `write_html` e ao colar (classe para CSS).
- Exportação Tailwind fiel e round-trip.

Resultado (ver [TAILWIND.md](TAILWIND.md)):

- Core: motor `@mockup/core/tailwind` com o compilador oficial `tailwindcss` v4 (JS puro, roda no daemon, no editor e nos testes; carregado sob demanda no editor), cache por tokens do `@theme`; `node.classes` (dica de round-trip), `node.states` (`hover`, `focus`, `active`, `disabled`, `dark`, `sm`..`2xl` e combinações), `cssBase: 'tailwind'` (preflight no canvas, render e export); ops `setClasses`, `setStates`, `setCssBase`; caminho inverso canonicalizado (`canonicalizeCandidates`, com design system leve sem `mask-*`/`scroll-*` e cache por motor: 1ª exportação da landing 2,4 s → 1,2 s a frio, ~15 ms repetida) e conferido contra o compilador; preset de tokens do shadcn/ui.
- Exportadores: Tailwind e React com o motor (classes do autor reaproveitadas, variantes, `@custom-variant dark`, neutralização de `line-height` só onde precisa); HTML com regras por estado (`:hover`, `@media`, tema `dark`).
- Editor: render com estados (breakpoint pela largura do frame, `dark` pelo tema), prévia de estado na barra, seção "Classes" com autocomplete, avisos, "Mostrar como Tailwind" e lista de estados, CSS base no painel do documento, colar HTML Tailwind.
- MCP: `write_html` com detecção de Tailwind (`tailwind`, `css: 'tailwind'`), `import_component`, `set_classes`, `get_classes`, `suggest_classes`, `get_tailwind_config`, `set_css_base`, `state` em `get_screenshot`/`get_styles`/`update_styles`, `get_code`/`export` com o motor, guia `tailwind`.

Pendências: variantes de grupo/atributo e pseudo-elementos só ficam na classe; os campos de estilo do painel não editam estados (só o campo de classes); `animate-*` não anima no canvas; o `state` do screenshot não foi exercitado no Electron real (só com provider falso); a primeira exportação de cada motor (tokens novos) ainda custa ~1 s de aquecimento da canonicalização do Tailwind.

### Fase 4 — Componentes (`feature/design-system`, concluída)

- Mestres e instâncias com overrides; propriedades e variantes.
- Biblioteca por documento.
- MCP para criar, instanciar e destacar.

Resultado (ver [COMPONENTES.md](COMPONENTES.md)):

- Core: `doc.components` (`ComponentDef` com props `string|number|boolean|enum|color|slot`, variantes por `when` e raiz), nó `instance` com `props` e `overrides` por caminho de ids do principal; slots como contêineres `data-slot` filhos reais da instância (reaproveitam ops, camadas e seleção); `expandInstance`/`expandDocument` com ids virtuais `instância/caminho` e compartilhamento estrutural; `applyOp` roteia ops em ids virtuais (vira override) e em nós do principal (vira `updateComponent`); ops `addComponent`, `deleteComponent`, `updateComponent`, `replaceNode`, `setInstanceProps`, `setInstanceOverrides`; planejadores `createComponentOps` (com `bind`), `instanceNodeFor`, `detachInstanceOps`, `pushOverridesToMainOps`, `resetInstanceOps`, `importKitOps`. Documentos antigos sem `components` continuam iguais.
- Exportadores: HTML, Tailwind e SVG expandem as instâncias; React gera um componente tipado por principal (enum como união de literais, slots como `ReactNode`/`children`, variantes condicionais).
- Kit `kits/shadcn-like.mockup.json` (Button, Input, Card, Navbar, Tabs, Dialog, Table, List, tokens shadcn e tema `dark`), servido em `/api/kits` e empacotado em `resources/kits`. Ícones: Heroicons (`@iconify-json/heroicons`, MIT) ao lado do Lucide, com busca unificada por kit.
- MCP: `list_components`, `get_component`, `create_component`, `update_component`, `update_component_html`, `delete_component`, `insert_component` (importa o kit se preciso), `set_instance_props`, `set_instance_override`, `reset_instance`, `detach_instance`, `push_overrides_to_main`, `go_to_main`, `import_kit`; leitura e screenshot por ids virtuais e de principais; guia `components`.
- Editor: aba Componentes (biblioteca e kit, arrastar/clicar), Ctrl+Alt+K, edição isolada do principal, indicador roxo, painel de props, slots editáveis, ir para principal, destacar, restaurar e enviar ao principal.

Pendências: overrides não removem atributos/estados do principal (sem `unsetAttrs`/`unsetStates`); `update_component_html` gera ids novos (overrides antigos perdem efeito); renomear prop no painel não reescreve os `{{placeholders}}`; inserir um componente de kit importa o kit inteiro; o React não exporta variantes que mudam atributos, visibilidade ou props de aninhadas, nem extrai `.map` dentro dos componentes; "Restaurar"/"Enviar ao principal" não valem para instâncias aninhadas.

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

Pendências: no app empacotado o sharp vem em `resources/native` só para a plataforma em que o pacote foi gerado (Windows x64); recorte com `object-view-box` só aparece no Chromium (o código exportado mostra a imagem inteira em Firefox/Safari); miniaturas de documentos fechados sem as fontes embutidas; estilos não aceitam bindings; importação em lote e SVG inline editável seguem abertos; a validação dos dados serializa a lista inteira (`JSON.stringify` no `DataSchema`) a cada `setData`; `fetchBytes` (imagens e dados por URL) não filtra endereços de rede privada.

### Fase 7 — Vetores e grid

- Desenho vetorial básico: pen, formas, operações booleanas.
- Grids e colunas, guias e snapping.

### Fase 8 — Efeitos e embeds

- Filtros, máscaras, blend modes.
- Embeds (vídeo, iframe, Lottie) e animações simples.

### Fase 9 — Assistente de IA no editor (`feature/design-system`, concluída)

- Chat lateral usando as mesmas ferramentas do MCP.
- Sugestões de layout e variações.

Resultado (ver [ASSISTENTE.md](ASSISTENTE.md) e [SCRIPTS.md](SCRIPTS.md)):

- Core: grupos de undo no `History` (aplicações seguidas do mesmo grupo viram uma entrada; `closeGroup`), protocolo WS `assistant:*`, `script:*` e `remix`, planejadores puros de remix (`planRemix`, `colorScale` em OKLCH).
- Assistente: backends `claude` (`claude -p` com stream-json) e `codex` (`codex exec --json`) por subprocesso, detectados no PATH (`.exe`/`.cmd`), com o MCP do próprio daemon em `/mcp?turn=<token>`; contexto da seleção (ids, resumo da árvore, screenshot); streaming por `assistant:event`; um grupo de undo por turno (undo/redo recusados no turno; sessão do turno encerrado não escreve); cancelamento e timeout matando a árvore de processos; histórico em `<base>.assistant.json` ao lado do documento e `--resume` da conversa; interface `AgentBackend` para uma API direta.
- Scripts: sandbox em worker (`eval`, `resourceLimits`, timeout por `terminate`) com `node:vm` sem geração de código e ponte só por JSON; API `doc.select/get/selection/apply/screenshot/create/tokens` e handles com `style`/`attrs` em Proxy; uma execução = um undo; biblioteca `scripts/*.js`; gerar com IA; MCP `run_script` e `list_scripts`.
- Remix: `color-scale` (10 tons), `font-pairs`, `spacing` (escala 4/8), `layout` (3 rearranjos do flex) e `ai`, pelo menu de contexto e pelo MCP `remix`; frames lado a lado num único undo.
- Editor: abas Design/Assistente/Scripts no painel direito, chat com streaming e chips de ferramentas, painel de scripts com CodeMirror 6 (chunk sob demanda), Remix no menu de contexto.
- Guias `assistant` e `scripts`.
- Corrigido no app desktop: o bundle do `ws` trocava o `bufferutil` opcional por um objeto vazio e o daemon travava no primeiro frame de 32 bytes ou mais vindo de um cliente WS (bug anterior à fase; teste de regressão no `headless.integration.test`).
- Verificado com as CLIs reais nesta máquina (Claude Code 2.1.319 e Codex 0.163.0): "deixe o botão primário mais destacado" altera o botão selecionado e um único undo desfaz o turno.

Pendências: edição do usuário no meio de um turno quebra a fusão do grupo (o turno vira mais de um passo de undo); o Codex não permite desligar o shell embutido (roda em sandbox `read-only`); scripts recusam a palavra `import` em qualquer lugar do texto (defesa contra `import()` na vm); sem `save_script` no MCP; o chunk do CodeMirror tem ~507 kB.
