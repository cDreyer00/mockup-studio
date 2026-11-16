# Arquitetura

## Visão geral

```
 Agente (Claude Code, Codex)
        |  stdio (JSON-RPC)
        v
 mockup mcp  (@mockup/cli)  -- proxy stdio <-> Streamable HTTP
        |  HTTP  POST/GET/DELETE /mcp
        v
 +-------------------------------------------+        +-------------------+
 | Daemon (@mockup/server) 127.0.0.1:4747    |        | Disco             |
 |  DocumentStore: docs, History, seleção    | -----> | *.mockup.json     |
 |  HTTP /api/*  /assets/*   MCP /mcp        |  save  | assets/           |
 |  WebSocket /ws                            |        | daemon.json ...   |
 +-------------------------------------------+        +-------------------+
        ^  WS (eventos e requisições)
        v
 Editor (@mockup/editor, navegador)
```

Todas as mutações passam pelo daemon, que é a única fonte da verdade em tempo de execução. O editor e o MCP são clientes do mesmo `DocumentStore`. Clientes MCP HTTP (alternativa) falam direto com `/mcp`, sem o proxy.

## Pacotes

| Pacote             | Nome                                   | Responsabilidade                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | `@mockup/core`                         | Modelo de documento, ops puras com inverso, `History` (undo/redo), `htmlToNodes`/`nodesToHtml`, `getTreeSummary`, `getComputedLike`, schema zod (`parseDocument`/`serializeDocument`), exportador HTML standalone. Sem DOM e sem APIs do Node. |
| `packages/server`  | `@mockup/server` (bin `mockup-daemon`) | Daemon Node em 127.0.0.1. `DocumentStore` (documentos abertos, undo por documento, seleção, autosave com debounce de 800 ms), HTTP, WebSocket e MCP. Express 5 e ws.                                                                           |
| `packages/cli`     | `@mockup/cli` (bin `mockup`)           | `mockup mcp`, `mockup serve [--port]`, `mockup open <arquivo>`, `mockup new <arquivo> [--name]`.                                                                                                                                               |
| `packages/editor`  | `@mockup/editor`                       | Vite + React 19. Nesta etapa, visualizador somente leitura (páginas, frames e nós como HTML real, zoom e pan), atualizado em tempo real via WS.                                                                                                |
| `packages/desktop` | `@mockup/desktop`                      | Somente README nesta etapa. Electron e motor de render na tarefa 3.                                                                                                                                                                            |

## Fluxo de uma edição

1. Um cliente (ferramenta MCP ou editor via WS `op:apply`) produz uma ou mais `Op` serializáveis.
2. O `DocumentStore` aplica cada op ao documento (função pura: devolve novo documento e as ops inversas) e registra o par no `History` do documento.
3. A `revision` do documento é incrementada, o documento é marcado como `dirty` e o autosave é reagendado (debounce de 800 ms).
4. O store emite o evento de mudança com `source` (`editor`, `mcp` ou `system`).
5. O servidor WS envia `doc:changed` (com `ops`, `source`, `revision` e o `doc` completo) a todos os clientes conectados.
6. O editor substitui o documento recebido e renderiza novamente. Quem originou a edição recebe também um `ack` com o `reqId`.
7. Toda escrita via MCP devolve, na resposta, o resumo da árvore com profundidade 2.

Undo e redo executam as ops inversas guardadas no `History` e seguem o mesmo caminho (evento, WS, editor).

## Formato de arquivo

Arquivo `*.mockup.json`: JSON com 2 espaços e chaves em ordem estável. Imagens ficam em `assets/` ao lado do arquivo. `version` é sempre `1`. A fonte da verdade dos tipos é `packages/core/src/types.ts`; o schema zod valida na leitura.

### Document

| Campo     | Tipo                    | Descrição                                                           |
| --------- | ----------------------- | ------------------------------------------------------------------- |
| `version` | `1`                     | Versão do esquema.                                                  |
| `id`      | string                  | Id do documento (`doc_xxxxxxxx`).                                   |
| `name`    | string                  | Nome do documento.                                                  |
| `pages`   | `Page[]`                | Páginas.                                                            |
| `tokens`  | `Record<string,string>` | Variáveis CSS do documento, ex. `{ "--color-primary": "#6c5ce7" }`. |
| `fonts`   | `FontRef[]`             | Fontes usadas.                                                      |
| `meta`    | `DocumentMeta`          | `createdAt`, `updatedAt` (ISO 8601) e chaves extras livres.         |

### Page

| Campo        | Tipo     | Descrição                              |
| ------------ | -------- | -------------------------------------- |
| `id`         | string   | Id da página (`pg_xxxxxxxx`).          |
| `name`       | string   | Nome.                                  |
| `frames`     | `Node[]` | Nós raiz da página (frames).           |
| `background` | string   | Fundo do canvas da página (valor CSS). |

### Node

| Campo      | Tipo                                                 | Descrição                                                                                              |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`       | string                                               | Id com prefixo por tipo.                                                                               |
| `type`     | `'frame' \| 'element' \| 'text' \| 'image' \| 'svg'` | Tipo do nó.                                                                                            |
| `name`     | string                                               | Nome legível (camada).                                                                                 |
| `tag`      | string                                               | Tag HTML: `div`, `section`, `button`, `img`, `h1`, `p`, `span`...                                      |
| `attrs`    | `Record<string,string>`                              | Atributos HTML, sem `style` e sem `class`.                                                             |
| `style`    | `Record<string,string>`                              | CSS real em kebab-case, ex. `{ "display": "flex", "gap": "24px" }`. Tokens via `var(--color-primary)`. |
| `text`     | string (opcional)                                    | Conteúdo textual (`type: 'text'`).                                                                     |
| `src`      | string (opcional)                                    | Imagem: caminho relativo em `assets/` ou data URL (`type: 'image'`).                                   |
| `svg`      | string (opcional)                                    | Markup SVG inline (`type: 'svg'`).                                                                     |
| `children` | `Node[]`                                             | Filhos.                                                                                                |
| `locked`   | boolean                                              | Bloqueado para edição na interface.                                                                    |
| `hidden`   | boolean                                              | Oculto.                                                                                                |
| `position` | `{ x, y }` (opcional)                                | Posição no canvas (frames raiz) ou x/y de filhos com `position: absolute`.                             |

Frames são os nós raiz da página: têm `width` e `height` em `style` e `position` no canvas. Servem como artboards e como breakpoints.

### FontRef

| Campo     | Tipo                                       | Descrição                                  |
| --------- | ------------------------------------------ | ------------------------------------------ |
| `family`  | string                                     | Nome da família.                           |
| `source`  | `'local' \| 'file' \| 'google'` (opcional) | Origem da fonte.                           |
| `files`   | `string[]` (opcional)                      | Arquivos de fonte (relativos a `assets/`). |
| `weights` | `number[]` (opcional)                      | Pesos disponíveis.                         |

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

| Op (`type`)      | Campos                                                                   | Inverso                                                            |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `createNode`     | `node`, `parentId?` (null = frame raiz), `pageId?`, `index?`             | `deleteNodes` do nó criado                                         |
| `deleteNodes`    | `nodeIds[]`                                                              | `createNode` de cada nó removido, na posição original              |
| `moveNodes`      | `nodeIds[]`, `parentId?` (null = frame raiz), `pageId?`, `index?`        | `moveNodes` de volta ao pai e índice anteriores                    |
| `updateStyles`   | `changes[{ nodeId, set?, unset? }]` ou `nodeIds[]` + `styles` + `unset?` | `updateStyles` restaurando valores e chaves anteriores             |
| `setText`        | `changes[{ nodeId, text }]`                                              | `setText` com o texto anterior                                     |
| `setAttrs`       | `changes[{ nodeId, set?, unset? }]`                                      | `setAttrs` restaurando atributos anteriores                        |
| `renameNodes`    | `changes[{ nodeId, name }]`                                              | `renameNodes` com os nomes anteriores                              |
| `duplicateNodes` | `nodeIds[]`, `idMap?` (oldId para newId, inclui descendentes)            | `deleteNodes` dos clones; o `idMap` é devolvido em `result.idMap`  |
| `setPosition`    | `changes[{ nodeId, position }]`                                          | `setPosition` com as posições anteriores                           |
| `createPage`     | `pageId`, `name`, `index?`, `background?`, `frames?`                     | `deletePage`                                                       |
| `deletePage`     | `pageId`                                                                 | `createPage` com nome, índice, fundo e `frames` da página removida |
| `renamePage`     | `pageId`, `name`                                                         | `renamePage` com o nome anterior                                   |
| `setTokens`      | `set?`, `unset?`                                                         | `setTokens` restaurando valores e removendo os criados             |
| `setNodeFlags`   | `changes[{ nodeId, locked?, hidden? }]`                                  | `setNodeFlags` com os valores anteriores                           |
| `setTag`         | `changes[{ nodeId, tag }]`                                               | `setTag` com as tags anteriores (tags bloqueadas e void com filhos são recusadas; `image` só `img`, `svg` só `svg`) |

Para que o histórico seja determinístico, o `idMap` de `duplicateNodes` e os ids de `createNode` ficam registrados na op guardada.

## Protocolo WebSocket

Endpoint `ws://127.0.0.1:4747/ws`. Mensagens JSON, uma por frame. Tipos em `packages/core/src/protocol.ts`. Ao conectar, o servidor envia `hello`.

O `Origin` do handshake é validado (`isAllowedOrigin`): aceita ausente (clientes não-navegador), `file://` e `http(s)` em `localhost`, `127.0.0.1` ou `[::1]` (qualquer porta). `Origin: null` é recusado, porque iframes `sandbox` e páginas `data:` de qualquer site mandam esse valor. O resto recebe 403. Em `op:apply`, `docId` (string) e `ops` (array) são exigidos; cada op é validada pelo core e qualquer exceção vira `error` com o `reqId`.

### Servidor para cliente

| `type`              | Campos                                                                                                     | Descrição                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `hello`             | `documents: OpenDocumentInfo[]`, `activeDocId`, `doc` (documento ativo ou null), `selection[]`, `revision`, `history: { canUndo, canRedo }` | Estado inicial.                                       |
| `doc:opened`        | `info`, `doc`, `history`                                                                                            | Documento aberto ou criado.                           |
| `doc:changed`       | `docId`, `ops[]`, `source`, `revision`, `doc`, `history`                                                              | Mudança aplicada. No MVP inclui o documento completo. |
| `doc:saved`         | `docId`, `path`                                                                                            | Documento salvo em disco.                             |
| `doc:closed`        | `docId`                                                                                                    | Documento fechado.                                    |
| `selection:changed` | `docId`, `nodeIds[]`, `source`                                                                             | Seleção alterada.                                     |
| `active:changed`    | `docId` (ou null)                                                                                          | Documento ativo alterado.                             |
| `ack`               | `reqId`, `result?`                                                                                         | Resposta de sucesso a uma requisição.                 |
| `error`             | `reqId?`, `message`                                                                                        | Erro.                                                 |

`source` é `'editor'`, `'mcp'` ou `'system'`. `OpenDocumentInfo` tem `docId`, `name`, `path` (null se não salvo), `dirty` e `revision`.

### Cliente para servidor

Toda requisição tem `reqId` (string) e é respondida com `ack` ou `error`.

| `type`          | Campos               | Descrição                        |
| --------------- | -------------------- | -------------------------------- |
| `op:apply`      | `docId`, `ops[]`     | Aplica ops.                      |
| `selection:set` | `docId`, `nodeIds[]` | Define a seleção.                |
| `doc:open`      | `path`               | Abre um arquivo.                 |
| `doc:new`       | `path`, `name`       | Cria um documento (ack com o info, sem `doc`). |
| `doc:close`     | `docId`              | Fecha o documento (salva se pendente); ack `{}`. |
| `doc:save`      | `docId?`             | Salva (padrão: documento ativo). |
| `undo`          | `docId?`             | Desfaz.                          |
| `redo`          | `docId?`             | Refaz.                           |
| `active:set`    | `docId`              | Define o documento ativo.        |

## HTTP

Base `http://127.0.0.1:4747`.

O header `Host` é validado antes de qualquer rota (`isAllowedHost`, proteção contra DNS rebinding): o hostname deve ser `127.0.0.1`, `localhost`, `::1` ou o `host` configurado no daemon, com qualquer porta. Caso contrário, 403 `{ error: 'Host não permitido' }`. Erros: `HttpError` e erros 4xx do body-parser mantêm o status; qualquer outro vira 500 `{ error: 'Erro interno' }` (detalhe só no log).

| Rota                   | Descrição                                                        |
| ---------------------- | ---------------------------------------------------------------- |
| `GET /api/health`      | Estado do daemon; usado pelo CLI para confirmar o `daemon.json`. |
| `GET /api/docs`        | `{ documents, activeDocId }` com os documentos abertos.          |
| `GET /api/docs/:id`    | `{ info, doc, selection }`: documento completo.                  |
| `POST /api/open`       | Corpo `{ path }`. Abre um arquivo.                               |
| `POST /api/new`        | Corpo `{ path, name }`. Cria um documento.                       |
| `POST /api/save`       | Corpo `{ docId? }`. Salva.                                       |
| `POST /api/active`     | Corpo `{ docId }`. Define o documento ativo.                     |
| `GET /api/recent`      | `{ recent: string[] }`: documentos recentes que ainda existem em disco. |
| `POST /api/assets/:docId?name=` | Corpo binário cru (até 20 MB; extensões png, jpg, jpeg, gif, webp, svg, avif). Grava em `assets/` com nome sanitizado e sufixo `-1`, `-2` se já existir; responde `{ src }` relativo a `assets/`. 404 documento inexistente, 409 sem caminho (salvar antes), 400 nome/extensão/corpo inválido, 413 grande demais. |
| `GET /assets/:docId/*` | Serve arquivos de `assets/` do documento.                        |
| `/ws`                  | WebSocket (upgrade).                                             |
| `/mcp`                 | MCP Streamable HTTP.                                             |

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
3. Se responder, usa esse daemon. Caso contrário (arquivo ausente, obsoleto ou sem resposta), sobe um daemon headless destacado e espera ficar saudável.
4. Faz proxy stdio para Streamable HTTP em `mcpUrl`.

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
