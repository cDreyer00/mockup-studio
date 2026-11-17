# Arquitetura

## Visão geral

```
 Agente (Claude Code, Codex)
        |  stdio (JSON-RPC)
        v
 mockup mcp  (@mockup/cli)  -- proxy stdio <-> Streamable HTTP
        |  1. usa o daemon vivo (daemon.json + /api/health)
        |  2. senão sobe o Electron headless (screenshot)
        |  3. senão sobe o daemon Node (sem render)
        |  HTTP  POST/GET/DELETE /mcp
        v
 +---------------------------------------------------+        +-------------------+
 | App desktop (@mockup/desktop, Electron)           |        | Disco             |
 |  +---------------------------------------------+  | -----> | *.mockup.json     |
 |  | Daemon in-process (@mockup/server)          |  |  save  | assets/           |
 |  |  127.0.0.1:4747                             |  |        | daemon.json ...   |
 |  |  DocumentStore: docs, History, seleção      |  |        +-------------------+
 |  |  HTTP /api/* /assets/* /render/* e o editor |  |
 |  |  em /   MCP /mcp   WebSocket /ws            |  |
 |  +---------------------------------------------+  |
 |  RenderService: janela oculta em /render.html,    |
 |  captura via CDP (Page.captureScreenshot)         |
 |  Janela do editor (BrowserWindow) + menu nativo   |
 +---------------------------------------------------+
        ^  WS (eventos e requisições)
        v
 Editor (@mockup/editor: janela do app ou navegador)
```

Todas as mutações passam pelo daemon, que é a única fonte da verdade em tempo de execução. O editor e o MCP são clientes do mesmo `DocumentStore`. Clientes MCP HTTP (alternativa) falam direto com `/mcp`, sem o proxy.

O daemon não depende do Electron: `startDaemon` recebe um `RenderProvider` opcional. O app desktop injeta o `RenderService` (e o `editorDir` do editor buildado). Sem ele (daemon Node puro), screenshot, `get_layout` e o SVG medido ficam indisponíveis, e `GET /api/health` devolve `render: false`. No modo `--headless` o app não abre janela: é o que `mockup mcp` e `mockup serve --render` sobem.

## Pacotes

| Pacote             | Nome                                   | Responsabilidade                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | `@mockup/core`                         | Modelo de documento, ops puras com inverso, `History` (undo/redo), `htmlToNodes`/`nodesToHtml`, `getTreeSummary`, `getComputedLike`, schema zod (`parseDocument`/`serializeDocument`). Exportadores html, tailwind, react e svg (`export/`, ver [EXPORT.md](EXPORT.md)). `layout.ts` (`LayoutNode`, geometria medida), `fonts.ts` (`@font-face` das fontes embutidas), `base.ts` (CSS base único do documento: o mesmo no canvas, no render e no código exportado, com o preflight do Tailwind quando `cssBase: 'tailwind'`; o CSS da interface do editor não vaza no design) e `states.ts` (estados por variante). Subpacote `@mockup/core/tailwind`: motor Tailwind v4 com o compilador oficial (ver [TAILWIND.md](TAILWIND.md)). Sem DOM e sem APIs do Node. |
| `packages/server`  | `@mockup/server` (bin `mockup-daemon`) | Daemon Node em 127.0.0.1. `DocumentStore` (documentos abertos, undo por documento, seleção, autosave com debounce de 800 ms, salvar como), HTTP (inclui `/render/*` e o editor estático em `/`), WebSocket e MCP. Contrato `RenderProvider`. Express 5 e ws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/cli`     | `@mockup/cli` (bin `mockup`)           | `mockup mcp`, `mockup serve [--port] [--render]`, `mockup stop`, `mockup open <arquivo>`, `mockup new <arquivo> [--name]`. Descobre o daemon e localiza o Electron para subir o modo headless (`electron.ts`, `discover.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/editor`  | `@mockup/editor`                       | Vite + React 19 + zustand. Editor visual completo (canvas, seleção, camadas, propriedades, páginas, clipboard, undo/redo via daemon); toda mutação vira `Op` enviada por WS. Ver [EDITOR.md](EDITOR.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/desktop` | `@mockup/desktop`                      | App Electron: janela do editor, daemon in-process, `RenderService` (screenshot via CDP), menu nativo em português, preload com diálogos nativos, modo `--headless`, instalador NSIS e portátil (electron-vite + electron-builder). Ver o [README do pacote](../packages/desktop/README.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Fluxo de uma edição

1. Um cliente (ferramenta MCP ou editor via WS `op:apply`) produz uma ou mais `Op` serializáveis.
2. O `DocumentStore` aplica cada op ao documento (função pura: devolve novo documento e as ops inversas) e registra o par no `History` do documento.
3. A `revision` do documento é incrementada, o documento é marcado como `dirty` e o autosave é reagendado (debounce de 800 ms).
4. O store emite o evento de mudança com `source` (`editor`, `mcp` ou `system`).
5. O servidor WS envia `doc:changed` (com `ops`, `source`, `revision` e o `doc` completo) a todos os clientes conectados.
6. O editor integra o documento recebido com compartilhamento estrutural (nós que não mudaram mantêm a identidade) e renderiza só o que mudou. Quem originou a edição recebe também um `ack` com o `reqId`, depois do `doc:changed`.
7. Toda escrita via MCP devolve, na resposta, o resumo da árvore com profundidade 2.

Undo e redo executam as ops inversas guardadas no `History` e seguem o mesmo caminho (evento, WS, editor).

## Editor

- **Estado**: `docStore` (espelho do daemon: documentos, documento ativo, histórico, atividade do agente) e `uiStore` (seleção, hover, ferramenta, página ativa, viewport, prévias de arrasto), ambos zustand. Só o cliente WS escreve no `docStore`.
- **Cliente** (`client/daemon.ts`): uma requisição por `reqId`, resolvida pelo `ack` ou rejeitada pelo `error`; `apply(ops)` = uma entrada no histórico. A seleção local é publicada com `selection:set`; `selection:changed` com `source: 'mcp'` seleciona e enquadra os nós no editor.
- **Render**: frames e nós como HTML/CSS real (`React.memo` por nó); seleção, alças e réguas numa camada de overlay; pan/zoom direto no `transform`.
- **Prévias**: arrastar e redimensionar mostram uma prévia local transitória; ao soltar, as ops vão numa única chamada.
- **Badge do agente**: frames tocados por ops com `source: 'mcp'` nos últimos 4 s.

Detalhes, atalhos e medições em [EDITOR.md](EDITOR.md).

## Render e screenshot

O daemon não conhece o Electron. Ele usa o contrato `RenderProvider` (`packages/server/src/render.ts`):

| Método               | Descrição                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture(req)`       | `{ doc, docId, nodeId, scale?, format?, quality?, maxWidth?, transparent? }` devolve `{ data, mime, width, height, pixelWidth, pixelHeight }` (`width`/`height` em px CSS do nó). |
| `measure(target)`    | Devolve o `LayoutNode` da subárvore do nó.                                                                                                                                        |
| `close()` (opcional) | Libera a janela de render; o daemon chama ao encerrar.                                                                                                                            |

Sem provider, as chamadas de render falham com a mensagem `RENDER_UNAVAILABLE` (ferramentas MCP com `isError`, rota `/render` com 503).

### Página de render

`packages/editor/render.html` (build do editor, servida em `/render.html`) monta só o frame do nó, com o mesmo componente de nó e o mesmo CSS base do canvas (`documentBaseCss`), sem seleção, sombra do artboard nem interface.

- `window.__mockupRenderReady` vira `true` quando a página está montada.
- `window.__mockupRender.render({ doc, docId, nodeId, transparent? })` renderiza o frame raiz do nó em 0,0 e devolve `RenderBox { frameId, frameWidth, frameHeight, x, y, width, height }`: o retângulo do nó relativo ao frame, em px CSS. O fundo é o da página do documento; com `transparent` o fundo fica transparente.
- `window.__mockupRender.measure(nodeId)` devolve o `LayoutNode` do nó já renderizado.
- Antes de responder, `render` espera as fontes (`@font-face` das fontes embutidas) e as imagens (`decode`, com limite de 5 s por espera).

### LayoutNode

Geometria medida no DOM real (`getBoundingClientRect` e `getComputedStyle`), em `packages/core/src/layout.ts`. Coordenadas em px CSS **relativas ao canto do frame raiz** (frame em 0,0, escala 1). Cada nó traz `id`, `name`, `type`, `tag`, `x`, `y`, `width`, `height`, um subconjunto do estilo computado (`LayoutStyle`), as linhas de texto renderizadas (`LayoutTextLine`: texto, retângulo e baseline aproximada) e os filhos. Alimenta `get_layout` e o exportador SVG.

### RenderService (app desktop)

`packages/desktop/src/main/render.ts` implementa o `RenderProvider`:

- **Uma janela reutilizável** carrega `/render.html` e espera `__mockupRenderReady`. Sem moldura, transparente, fora da tela, sem foco e fora da barra de tarefas (ver [Decisões técnicas](#decisões-técnicas)).
- **Fila serial:** uma operação por vez (capture e measure), mesmo se a anterior falhar.
- **Recuperação:** se o processo de render morrer (`render-process-gone`), a janela falhar ao ficar pronta ou uma operação passar de 30 s, a janela é destruída e recriada na próxima chamada.
- **Captura:** CDP (`webContents.debugger`) com `Emulation.setDeviceMetricsOverride` (viewport maior ou igual ao frame, `deviceScaleFactor` = escala) e `Page.captureScreenshot` com `clip` do nó. A escala vai de 1 a 3. `transparent` (só PNG) zera o fundo padrão. Se o CDP falhar, cai em `capturePage` (sem escala).
- **Formato:** `maxWidth` reduz com `nativeImage.resize` (qualidade `best`); JPG sai de `nativeImage.toJPEG` (qualidade padrão 90). Limite de 16384 px por lado após a escala, com erro claro.
- **Cache LRU** limitado a 256 MB (soma dos bytes das imagens), chaveado pelo sha256 de `{ frame do nó, tokens, fontes, fundo da página, docId, nodeId, escala, formato, qualidade, maxWidth, transparent, tamanho e data dos arquivos referenciados }` (`src` de imagens, `url()` relativos e fontes, lidos de `assets/`): trocar um arquivo mantendo o nome invalida o cache.
- **Limites e isolamento:** a viewport (`frame × escala`) é validada contra 16384 px por lado antes de redimensionar a janela; a janela de render nega navegação e novas janelas.

## Formato de arquivo

Arquivo `*.mockup.json`: JSON com 2 espaços e chaves em ordem estável. Imagens ficam em `assets/` ao lado do arquivo. `version` é sempre `1`. A fonte da verdade dos tipos é `packages/core/src/types.ts`; o schema zod valida na leitura.

### Document

| Campo       | Tipo                                      | Descrição                                                                                |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `version`   | `1`                                       | Versão do esquema.                                                                       |
| `id`        | string                                    | Id do documento (`doc_xxxxxxxx`).                                                        |
| `name`      | string                                    | Nome do documento.                                                                       |
| `pages`     | `Page[]`                                  | Páginas.                                                                                 |
| `tokens`    | `Record<string,string>`                   | Variáveis CSS do documento, ex. `{ "--color-primary": "#6c5ce7" }`.                      |
| `tokenMeta` | `Record<string,{ group?, description? }>` | Opcional. Grupo e descrição por token (ver [TOKENS.md](TOKENS.md)).                      |
| `themes`    | `{ name, overrides }[]`                   | Opcional. Temas que sobrescrevem tokens; o frame usa um tema pelo atributo `data-theme`. |
| `fonts`     | `FontRef[]`                               | Fontes usadas.                                                                           |
| `cssBase`   | `'tailwind'` (opcional)                   | CSS base com o preflight do Tailwind v4 (ausente = base padrão).                         |
| `meta`      | `DocumentMeta`                            | `createdAt`, `updatedAt` (ISO 8601) e chaves extras livres.                              |

### Page

| Campo        | Tipo     | Descrição                              |
| ------------ | -------- | -------------------------------------- |
| `id`         | string   | Id da página (`pg_xxxxxxxx`).          |
| `name`       | string   | Nome.                                  |
| `frames`     | `Node[]` | Nós raiz da página (frames).           |
| `background` | string   | Fundo do canvas da página (valor CSS). |

### Node

| Campo      | Tipo                                                 | Descrição                                                                                                 |
| ---------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`       | string                                               | Id com prefixo por tipo.                                                                                  |
| `type`     | `'frame' \| 'element' \| 'text' \| 'image' \| 'svg'` | Tipo do nó.                                                                                               |
| `name`     | string                                               | Nome legível (camada).                                                                                    |
| `tag`      | string                                               | Tag HTML: `div`, `section`, `button`, `img`, `h1`, `p`, `span`...                                         |
| `attrs`    | `Record<string,string>`                              | Atributos HTML, sem `style` e sem `class`.                                                                |
| `style`    | `Record<string,string>`                              | CSS real em kebab-case, ex. `{ "display": "flex", "gap": "24px" }`. Tokens via `var(--color-primary)`.    |
| `text`     | string (opcional)                                    | Conteúdo textual (`type: 'text'`).                                                                        |
| `src`      | string (opcional)                                    | Imagem: caminho relativo em `assets/` ou data URL (`type: 'image'`).                                      |
| `svg`      | string (opcional)                                    | Markup SVG inline (`type: 'svg'`).                                                                        |
| `children` | `Node[]`                                             | Filhos.                                                                                                   |
| `locked`   | boolean                                              | Bloqueado para edição na interface.                                                                       |
| `hidden`   | boolean                                              | Oculto.                                                                                                   |
| `position` | `{ x, y }` (opcional)                                | Posição no canvas (frames raiz) ou x/y de filhos com `position: absolute`.                                |
| `classes`  | string (opcional)                                    | Classes Tailwind como foram escritas: dica de round-trip da exportação (ver [TAILWIND.md](TAILWIND.md)).  |
| `states`   | `Record<string, Record<string,string>>` (opcional)   | Estilos por variante: `hover`, `dark`, `md`, `md:hover`... (`states.ts`, ver [TAILWIND.md](TAILWIND.md)). |

Frames são os nós raiz da página: têm `width` e `height` em `style` e `position` no canvas. Servem como artboards e como breakpoints.

### FontRef

| Campo     | Tipo                                       | Descrição                                                               |
| --------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| `family`  | string                                     | Nome da família.                                                        |
| `source`  | `'local' \| 'file' \| 'google'` (opcional) | Origem da fonte. Só `file` gera `@font-face`; `local` apenas registra.  |
| `files`   | `string[]` (opcional)                      | Arquivos de fonte (relativos a `assets/`, ex. `fonts/inter-400.woff2`). |
| `weights` | `number[]` (opcional)                      | Peso de cada arquivo (paralelo a `files`) ou o intervalo coberto.       |
| `styles`  | `string[]` (opcional)                      | Estilo de cada arquivo (`normal` ou `italic`), paralelo a `files`.      |

`files[i]` tem o peso `weights[i]` e o estilo `styles[i]` quando as listas têm o mesmo tamanho; senão todos os arquivos cobrem o intervalo de `weights` (padrão 100 a 900). `fontFaceCss` (`fonts.ts`) gera as regras `@font-face`: o canvas e a página de render usam `/assets/<docId>/<arquivo>` e o código exportado usa `assets/<arquivo>`.

## Ids

`nanoid` com 8 caracteres do alfabeto `[0-9a-z]`, precedidos por um prefixo que identifica o tipo.

| Prefixo | Entidade  |
| ------- | --------- |
| `fr_`   | frame     |
| `el_`   | element   |
| `tx_`   | text      |
| `im_`   | image     |
| `sv_`   | svg       |
| `pg_`   | página    |
| `doc_`  | documento |

Funções em `ids.ts`: `newId`, `newNodeId(type)`, `newPageId`, `newDocumentId`, `typeFromId`.

## Operações e inversos

Definidas em `packages/core/src/ops.ts`. Cada op é um objeto JSON com `type`. `applyOp` devolve `{ doc, inverse, result? }`; `inverse` é a lista de ops que desfaz exatamente a aplicação.

| Op (`type`)      | Campos                                                                                | Inverso                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `createNode`     | `node`, `parentId?` (null = frame raiz), `pageId?`, `index?`                          | `deleteNodes` do nó criado                                                                                          |
| `deleteNodes`    | `nodeIds[]`                                                                           | `createNode` de cada nó removido, na posição original                                                               |
| `moveNodes`      | `nodeIds[]`, `parentId?` (null = frame raiz), `pageId?`, `index?`                     | `moveNodes` de volta ao pai e índice anteriores                                                                     |
| `updateStyles`   | `changes[{ nodeId, set?, unset? }]` ou `nodeIds[]` + `styles` + `unset?`              | `updateStyles` restaurando valores e chaves anteriores                                                              |
| `setText`        | `changes[{ nodeId, text }]`                                                           | `setText` com o texto anterior                                                                                      |
| `setAttrs`       | `changes[{ nodeId, set?, unset? }]`                                                   | `setAttrs` restaurando atributos anteriores                                                                         |
| `renameNodes`    | `changes[{ nodeId, name }]`                                                           | `renameNodes` com os nomes anteriores                                                                               |
| `duplicateNodes` | `nodeIds[]`, `idMap?` (oldId para newId, inclui descendentes)                         | `deleteNodes` dos clones; o `idMap` é devolvido em `result.idMap`                                                   |
| `setPosition`    | `changes[{ nodeId, position }]`                                                       | `setPosition` com as posições anteriores                                                                            |
| `createPage`     | `pageId`, `name`, `index?`, `background?`, `frames?`                                  | `deletePage`                                                                                                        |
| `deletePage`     | `pageId`                                                                              | `createPage` com nome, índice, fundo e `frames` da página removida                                                  |
| `renamePage`     | `pageId`, `name`                                                                      | `renamePage` com o nome anterior                                                                                    |
| `setTokens`      | `set?`, `unset?`, `theme?` (sobrescritas do tema)                                     | `setTokens` restaurando valores e removendo os criados                                                              |
| `setTokenMeta`   | `set?`, `unset?`                                                                      | `setTokenMeta` restaurando os metadados anteriores                                                                  |
| `setThemes`      | `themes[]`                                                                            | `setThemes` com a lista anterior                                                                                    |
| `replaceTokens`  | `tokens`, `tokenMeta?`, `themes?`                                                     | `replaceTokens` com o sistema anterior                                                                              |
| `renameToken`    | `from`, `to` (atualiza todas as `var()`; `result: { from, to, nodes, references }`)   | `renameToken` de volta e restauração dos valores alterados                                                          |
| `setNodeFlags`   | `changes[{ nodeId, locked?, hidden? }]`                                               | `setNodeFlags` com os valores anteriores                                                                            |
| `setTag`         | `changes[{ nodeId, tag }]`                                                            | `setTag` com as tags anteriores (tags bloqueadas e void com filhos são recusadas; `image` só `img`, `svg` só `svg`) |
| `setFonts`       | `fonts[]` (`FontRef`; substitui a lista inteira, sem famílias repetidas)              | `setFonts` com a lista anterior                                                                                     |
| `setSrc`         | `changes[{ nodeId, src }]` (só nós `image`)                                           | `setSrc` com os `src` anteriores                                                                                    |
| `setSvg`         | `changes[{ nodeId, svg, attrs? }]` (só nós `svg`, sanitizado)                         | `setSvg` com o markup anterior (e os `attrs` anteriores, se `attrs` veio, que substitui `node.attrs`)               |
| `setClasses`     | `changes[{ nodeId, classes }]` (`null`/`''` remove; não mexe no estilo)               | `setClasses` com as classes anteriores                                                                              |
| `setStates`      | `changes[{ nodeId, states }]` (substitui `node.states`; chaves validadas e canônicas) | `setStates` com os estados anteriores                                                                               |
| `setCssBase`     | `base` (`default` ou `tailwind`)                                                      | `setCssBase` com a base anterior                                                                                    |

`renameToken` também atualiza as `var()` dentro de `states` (inverso com `setStates`).

Para que o histórico seja determinístico, o `idMap` de `duplicateNodes` e os ids de `createNode` ficam registrados na op guardada.

## Protocolo WebSocket

Endpoint `ws://127.0.0.1:4747/ws`. Mensagens JSON, uma por frame. Tipos em `packages/core/src/protocol.ts`. Ao conectar, o servidor envia `hello`.

O `Origin` do handshake é validado (`isAllowedOrigin`): aceita ausente (clientes não-navegador) e `http(s)` em `localhost`, `127.0.0.1` ou `[::1]` (qualquer porta). `Origin: null` e `file://` são recusados (o app desktop carrega o editor de `http://127.0.0.1:<porta>`), porque iframes `sandbox` e páginas `data:` de qualquer site mandam esse valor. O resto recebe 403. Em `op:apply`, `docId` (string) e `ops` (array) são exigidos; cada op é validada pelo core e qualquer exceção vira `error` com o `reqId`.

### Servidor para cliente

| `type`              | Campos                                                                                                                                      | Descrição                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `hello`             | `documents: OpenDocumentInfo[]`, `activeDocId`, `doc` (documento ativo ou null), `selection[]`, `revision`, `history: { canUndo, canRedo }` | Estado inicial.                                                              |
| `doc:opened`        | `info`, `doc`, `history`                                                                                                                    | Documento aberto ou criado.                                                  |
| `doc:changed`       | `docId`, `ops[]`, `source`, `revision`, `doc`, `history`                                                                                    | Mudança aplicada. No MVP inclui o documento completo.                        |
| `doc:saved`         | `docId`, `path`                                                                                                                             | Documento salvo em disco.                                                    |
| `doc:closed`        | `docId`                                                                                                                                     | Documento fechado.                                                           |
| `agent:finished`    | `docId`, `nodeIds[]` (vazio = todos os frames)                                                                                              | O agente terminou (`finish_working`): o editor apaga o selo "IA" dos frames. |
| `selection:changed` | `docId`, `nodeIds[]`, `source`                                                                                                              | Seleção alterada.                                                            |
| `active:changed`    | `docId` (ou null)                                                                                                                           | Documento ativo alterado.                                                    |
| `ack`               | `reqId`, `result?`                                                                                                                          | Resposta de sucesso a uma requisição.                                        |
| `error`             | `reqId?`, `message`                                                                                                                         | Erro.                                                                        |

`source` é `'editor'`, `'mcp'` ou `'system'`. `OpenDocumentInfo` tem `docId`, `name`, `path` (null se não salvo), `dirty` e `revision`.

### Cliente para servidor

Toda requisição tem `reqId` (string) e é respondida com `ack` ou `error`.

| `type`          | Campos               | Descrição                                                         |
| --------------- | -------------------- | ----------------------------------------------------------------- |
| `op:apply`      | `docId`, `ops[]`     | Aplica ops.                                                       |
| `selection:set` | `docId`, `nodeIds[]` | Define a seleção.                                                 |
| `doc:open`      | `path`               | Abre um arquivo.                                                  |
| `doc:new`       | `path`, `name`       | Cria um documento (ack com o info, sem `doc`).                    |
| `doc:close`     | `docId`              | Fecha o documento (salva se pendente); ack `{}`.                  |
| `doc:save`      | `docId?`             | Salva (padrão: documento ativo).                                  |
| `doc:saveAs`    | `docId?`, `path`     | Salva em outro caminho (ver abaixo); ack com o info do documento. |
| `undo`          | `docId?`             | Desfaz.                                                           |
| `redo`          | `docId?`             | Refaz.                                                            |
| `active:set`    | `docId`              | Define o documento ativo.                                         |

`doc:saveAs` (`store.saveAs`): normaliza o caminho (`.json` vira `.mockup.json`) e **sobrescreve** o destino (o diálogo nativo já confirmou). Recusa com 409 se outro documento aberto usa o mesmo caminho. Copia o conteúdo de `assets/` para ao lado do novo arquivo (sem apagar a origem e sem sobrescrever arquivos já existentes), passa o documento a apontar para o novo caminho, emite `doc:saved` e atualiza os recentes. No editor: Ctrl+Shift+S, com o diálogo nativo no app desktop.

## HTTP

Base `http://127.0.0.1:4747`.

O header `Host` é validado antes de qualquer rota (`isAllowedHost`, proteção contra DNS rebinding): o hostname deve ser `127.0.0.1`, `localhost`, `::1` ou o `host` configurado no daemon, com qualquer porta. Caso contrário, 403 `{ error: 'Host não permitido' }`. Erros: `HttpError` e erros 4xx do body-parser mantêm o status; qualquer outro vira 500 `{ error: 'Erro interno' }` (detalhe só no log).

| Rota                                         | Descrição                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                            | Estado do daemon (`ok`, `name`, `pid`, `port`, `startedAt`, `version`, `docs`, `activeDocId`, `render`, `mode`, `canShutdown`); usado pelo CLI para confirmar o `daemon.json`. `render` é `true` quando há motor de render (app desktop ou Electron headless).                                                    |
| `GET /api/docs`                              | `{ documents, activeDocId }` com os documentos abertos.                                                                                                                                                                                                                                                           |
| `GET /api/docs/:id`                          | `{ info, doc, selection }`: documento completo.                                                                                                                                                                                                                                                                   |
| `POST /api/open`                             | Corpo `{ path }`. Abre um arquivo.                                                                                                                                                                                                                                                                                |
| `POST /api/new`                              | Corpo `{ path, name }`. Cria um documento.                                                                                                                                                                                                                                                                        |
| `POST /api/shutdown`                         | Encerra o daemon salvando os documentos (202); 409 no app com janela. Ver "Modo do daemon e encerramento por HTTP".                                                                                                                                                                                               |
| `POST /api/save`                             | Corpo `{ docId? }`. Salva.                                                                                                                                                                                                                                                                                        |
| `POST /api/active`                           | Corpo `{ docId }`. Define o documento ativo.                                                                                                                                                                                                                                                                      |
| `GET /api/recent`                            | `{ recent: string[] }`: documentos recentes que ainda existem em disco.                                                                                                                                                                                                                                           |
| `POST /api/assets/:docId?name=`              | Corpo binário cru (até 20 MB; extensões png, jpg, jpeg, gif, webp, svg, avif). Grava em `assets/` com nome sanitizado e sufixo `-1`, `-2` se já existir; responde `{ src }` relativo a `assets/`. 404 documento inexistente, 409 sem caminho (salvar antes), 400 nome/extensão/corpo inválido, 413 grande demais. |
| `GET /assets/:docId/*`                       | Serve arquivos de `assets/` do documento.                                                                                                                                                                                                                                                                         |
| `GET /render/:docId/:nodeId.(png\|jpg\|svg)` | Imagem do nó. Query: `scale` (1, 2 ou 3), `quality` (0 a 100, JPG), `maxWidth` (px), `transparent` (`1`/`true`, PNG). PNG e JPG vêm do `RenderProvider`; SVG vem de `exportSvg` (com `measure` quando há render; sem render, o fallback em `<foreignObject>`). `Cache-Control: no-store`.                         |
| `/ws`                                        | WebSocket (upgrade).                                                                                                                                                                                                                                                                                              |
| `/mcp`                                       | MCP Streamable HTTP.                                                                                                                                                                                                                                                                                              |
| `GET /` e demais caminhos do editor          | Editor estático (SPA), só quando o daemon recebe `editorDir` com `index.html`. Arquivos estáticos primeiro; `GET` sem extensão fora de `/api`, `/assets`, `/mcp`, `/ws` e `/render` devolve `index.html`. Mesma origem que a API, os assets e o WS.                                                               |

Respostas de `/render`:

| Código | Quando                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 400    | `scale` fora de 1, 2 ou 3; `quality` fora de 0 a 100; `maxWidth` inválido.                              |
| 404    | Extensão diferente de png, jpg e svg; documento ou nó inexistente.                                      |
| 500    | Falha do render ou do `exportSvg` (erro do render em `{ error }`; o do SVG é genérico, detalhe no log). |
| 503    | PNG/JPG sem motor de render (daemon Node puro).                                                         |

O SVG sai com a mesma CSP dos assets (`ASSET_CSP`: `default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`) e `X-Content-Type-Options: nosniff`, então aberto direto numa aba não roda script nem carrega recursos. Imagens do documento entram como data URL (lidas de `assets/`, sem sair da pasta).

## MCP

- Transporte: Streamable HTTP em `http://127.0.0.1:4747/mcp`, com `@modelcontextprotocol/sdk` 1.x.
- Sessões: o servidor atribui um id de sessão na inicialização; o cliente o envia no header `mcp-session-id` nas requisições seguintes.
- Proteção: o transporte usa `enableDnsRebindingProtection` com `allowedHosts` `127.0.0.1:<porta>`, `localhost:<porta>` e `[::1]:<porta>` (o SDK compara o header `Host` inteiro, com porta). Host externo recebe 403.
- Ciclo de vida: `mcp-session-id` desconhecido responde 404 (`-32001`, `Sessão não encontrada`) para o cliente reinicializar; requisição sem sessão que não seja `initialize` responde 400. `DELETE /mcp` encerra a sessão.
- TTL: sessão ociosa por mais de 30 min (`sessionTtlMs`) é fechada por uma varredura periódica; cada requisição renova o `lastSeen`.
- `mockup mcp` expõe o mesmo servidor por stdio, fazendo proxy para o endpoint HTTP.
- Ferramentas, convenções e guias em [MCP.md](MCP.md).

## Pasta de dados

`%LOCALAPPDATA%/MockupStudio` no Windows; nos demais sistemas, `~/.mockup-studio`. A variável `MOCKUP_DATA_DIR` sobrescreve.

| Arquivo       | Conteúdo                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| `config.json` | `{ port? }`                                                                                  |
| `recent.json` | Caminhos de documentos recentes.                                                             |
| `daemon.json` | `{ port, pid, startedAt, url, mcpUrl, wsUrl }`. Escrito ao subir o daemon, removido ao sair. |

`daemon.json` só é removido pelo próprio pid (`removeDaemonInfo(dir, process.pid)`): um daemon antigo que encerra não apaga o arquivo de um mais novo.

### Gravação

- `create` usa `normalizeDocumentPath` (`.json` vira `.mockup.json`) e abre com flag `wx`: nunca sobrescreve (erro `O arquivo já existe`).
- Cada documento tem uma fila de saves (`saveChain`): nunca há duas gravações simultâneas no mesmo arquivo. `dirty` só volta a `false` se a revisão gravada ainda for a atual.
- Gravação em temporário único (`<arquivo>.<pid>.<ts>.<contador>.<aleatório>.tmp`) seguido de `rename`, com 3 tentativas (50, 100 e 200 ms) em `EPERM`/`EBUSY`/`EACCES`. Em erro, o temporário é removido.

A porta padrão é 4747. Pode ser definida com `--port` ou `MOCKUP_PORT` (e `port` em `config.json`).

## Descoberta do daemon pelo CLI

`mockup mcp`:

1. Lê `daemon.json` da pasta de dados.
2. Confere com `GET /api/health` na porta registrada.
3. Se responder, usa esse daemon (se ele não tem render, veja "Daemon sem render" abaixo). Caso contrário (arquivo ausente, obsoleto ou sem resposta), sobe um daemon headless destacado e espera ficar saudável. A ordem de preferência é:
   1. **Electron headless** (com screenshot): `<exe> [app] --headless --port <porta>`, destacado, sem `ELECTRON_RUN_AS_NODE`. `MOCKUP_DATA_DIR` só é repassada se o usuário a definiu: senão o headless usa o mesmo `userData` (e o mesmo lock de instância única) do app aberto pelo menu Iniciar. O CLI espera `/api/health` com `render: true` (30 s); a saída vai para `daemon.log` na pasta de dados.
   2. **Daemon Node** (sem render), se o Electron não for encontrado, encerrar antes de responder ou estourar o tempo. O CLI registra em stderr o motivo e avisa que screenshot e layout medido ficam indisponíveis.
4. Faz proxy stdio para Streamable HTTP em `mcpUrl`.

O Electron é procurado em `locateElectron` (`packages/cli/src/electron.ts`), nesta ordem:

| Ordem | Origem                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| 1     | `MOCKUP_DESKTOP_EXE`: caminho do executável (app empacotado ou binário do Electron), se existir.                           |
| 2     | Pasta gravada no registro (`InstallLocation` da chave de desinstalação, HKCU e depois HKLM): cobre pasta personalizada.    |
| 3     | Instalação NSIS por usuário: `%LOCALAPPDATA%\Programs\Mockup Studio\Mockup Studio.exe` (Windows).                          |
| 4     | Pacote de desenvolvimento: `@mockup/desktop` buildado (`out/main/index.js`) com o binário de `electron` do `node_modules`. |

`MOCKUP_NO_ELECTRON=1` desliga a busca e força o daemon Node. `mockup serve --render` usa a mesma busca, mas roda o Electron headless em primeiro plano (stdio herdado) e falha com mensagem se não o encontrar; sem `--render`, `mockup serve` sobe o daemon Node, que serve o editor em `/` quando ele está buildado.

O daemon headless iniciado pelo `mockup mcp` (Electron ou Node) continua rodando depois que o proxy sai: é encerrado por sinal, por `mockup stop` ou pelo usuário.

### Modo do daemon e encerramento por HTTP

`GET /api/health` informa `mode`: `desktop` (app Electron, com janela ou headless), `headless` (daemon Node destacado pelo CLI) ou `serve` (`mockup serve` do usuário). `canShutdown` diz se `POST /api/shutdown` é aceito. A rota tem a proteção das demais escritas (Host local, Origin ausente ou local), responde 202 e fecha o daemon salvando os documentos. O Node standalone e o `mockup serve` encerram o processo; o Electron headless sai com `app.quit()`; o app com janela responde 409 e só fecha pela janela. `mockup stop` descobre o daemon e chama essa rota (sem matar processo por pid).

### Daemon sem render

Se o daemon achado tem `render: false` e há Electron disponível, `ensureDaemon` age conforme o modo. Em `headless` (iniciado pelo CLI): lê `GET /api/docs`, pede o shutdown, espera a porta liberar e sobe o Electron headless reabrindo os documentos pelo argv; se o Electron falhar, volta a um daemon Node com os mesmos documentos. Em `serve` (do usuário): mantém o daemon e avisa no log que o screenshot fica indisponível e como resolver (`mockup stop` ou `mockup serve --render`). Documentos sem arquivo não sobrevivem à troca. O app desktop faz o mesmo ao achar a porta ocupada por um daemon sem render: pede o shutdown, espera, sobe o daemon embutido e reabre os documentos dele e os do argv. Se o outro tiver render (outra instância Electron), a janela usa esse daemon.

## Segurança

- **Somente 127.0.0.1**, sem autenticação. O header `Host` é validado em todas as rotas (DNS rebinding).
- **Origem:** o WebSocket e as escritas HTTP (`/mcp` e `/api` fora de GET/HEAD/OPTIONS) só aceitam `Origin` ausente ou `http(s)` em `localhost`, `127.0.0.1` ou `[::1]` (`isAllowedOrigin`). `file://` e `null` **não** são mais aceitos: o app desktop serve o editor do próprio daemon, na mesma origem.
- **Janela do app:** `contextIsolation` ligado, `sandbox` ligado, sem `nodeIntegration`. Navegação para outra origem é bloqueada (links `http(s)` abrem no navegador) e `window.open` é negado. Só clipboard (leitura e escrita sanitizada) é permitido, e só para a origem do daemon.
- **Preload:** `window.mockupDesktop` só é exposto quando a página vem de `http://127.0.0.1` ou `http://localhost`; os handlers IPC conferem que o frame remetente é da origem do daemon.
- **Janela de render:** `sandbox`, `contextIsolation`, sem `nodeIntegration` e sem preload; só carrega `/render.html` do daemon.
- **SVG e assets:** respostas com `Content-Security-Policy` restritiva e `nosniff` (ver HTTP).
- **CSS exportado:** declarações com valor que escapa da declaração são recusadas na edição e descartadas na leitura e no export (ver [EXPORT.md](EXPORT.md)).

## Decisões técnicas

- **npm workspaces:** um repositório, builds e testes com um único `npm install`; pacotes referenciados por versão (`0.1.0`).
- **ESM em todo o monorepo**, TypeScript com `tsc`.
- **core sem DOM e sem Node:** roda igual no daemon, no editor, no Electron e nos testes.
- **SDK MCP 1.x** (`@modelcontextprotocol/sdk`). Existe uma v2 distribuída em pacotes separados; a migração fica para depois.
- **Express 5 e ws:** HTTP e WebSocket no mesmo servidor, sem framework adicional.
- **zod 4:** validação do arquivo e dos parâmetros das ferramentas.
- **Vitest 5:** testes unitários e de integração em todos os pacotes.
- **Documento completo no evento `doc:changed`:** simplifica os clientes no MVP; deltas por ops ficam para otimização posterior.
- **Somente 127.0.0.1:** uso local, sem autenticação.
- **Electron 45 + electron-vite + electron-builder:** o processo principal sai em ESM com todas as dependências embutidas (server, core, express, ws, SDK MCP, zod); só `electron` fica externo, então o pacote final não leva `node_modules`. O preload sai em CJS (exigência do sandbox). O editor vem de `packages/editor/dist` (dev) ou de `resources/editor` (empacotado). Saída em `dist/`: NSIS por usuário e portátil, sem assinatura de código.
- **CDP `Page.captureScreenshot` em vez de `capturePage`:** `capturePage` captura na escala da tela e não aceita `deviceScaleFactor` nem recorte fora da viewport. Com `Emulation.setDeviceMetricsOverride` o render sai em escala 1 a 3 com `clip` do nó. `capturePage` fica como alternativa se o CDP falhar.
- **Janela de render "mostrada" fora da tela:** com a janela realmente oculta (`show: false` sem nunca exibir), o renderer do Chromium cai no `Page.captureScreenshot` no Windows. A janela é criada sem moldura, transparente, sem foco, fora da barra de tarefas, em `x,y = -20000` e recebe `showInactive()`.
- **Associação de `.mockup.json` por ProgID:** o Windows só enxerga a última extensão (`.json`); registrar `.json` como padrão sequestraria todos os JSON. O instalador (`build/installer.nsh`) cria o ProgID `MockupStudio.Document` (comando `"<exe>" "%1"`) e o lista em `HKCU\Software\Classes\.json\OpenWithProgids`, para aparecer em "Abrir com". O desinstalador remove as chaves.
- **CSS base único do documento (`base.ts`):** `documentBaseCss` é a mesma fonte para o canvas, a página de render e o código exportado. No canvas ele é restrito ao contêiner (`.cv-world`), com a tipografia só nos frames, para não atingir rótulos e selos da interface. O CSS da interface do editor não vaza no design.
- **Instância única no app:** `requestSingleInstanceLock` (por `userData`); uma segunda execução repassa os arquivos ao app aberto. Fechar a última janela com sessões MCP ativas deixa o app seguindo em headless.
