# MCP

O daemon expõe um servidor MCP que faz tudo o que o editor faz. Um agente (Claude Code, Codex) cria, lê e edita documentos por ele, e o editor aberto reflete as mudanças em tempo real.

## Como conectar

**stdio**, via CLI (o CLI descobre o daemon ou sobe um headless):

```bash
mockup mcp
# ou, sem link global:
node packages/cli/dist/bin.js mcp
```

Claude Code:

```bash
claude mcp add mockup-studio -- node <caminho-absoluto>/packages/cli/dist/bin.js mcp
```

**HTTP direto** (daemon rodando, `mockup serve` ou `npm run dev`):

```
http://127.0.0.1:4747/mcp
```

```bash
claude mcp add --transport http mockup-studio http://127.0.0.1:4747/mcp
```

O transporte é Streamable HTTP; as sessões usam o header `mcp-session-id`.

## Convenções

- Nomes de ferramentas e parâmetros em `snake_case`.
- Respostas compactas, pensadas para economizar contexto do agente.
- Toda escrita devolve o resumo da árvore com profundidade 2 (ver abaixo), para o agente confirmar o resultado sem nova leitura.
- `docId` é sempre opcional; quando omitido, vale o documento ativo.
- Estilos são CSS real em kebab-case (`"padding": "24px"`). Tokens são variáveis CSS usadas via `var(--color-primary)`.
- Ids têm prefixo por tipo: `fr_`, `el_`, `tx_`, `im_`, `sv_`, `pg_`, `doc_`.
- Erros voltam como resultado de ferramenta com `isError` e mensagem em texto.

## Fluxo típico

1. `get_basic_info` e `get_guide('getting-started')`: estado do app e regras de uso.
2. `create_document` ou `open_document`.
3. `get_tokens` / `set_tokens`: definir cores, fontes e espaçamentos.
4. `create_frame` (artboard) e `write_html` para montar o conteúdo.
5. `get_tree_summary`, `get_styles`, `update_styles`, `set_text`, `set_tag`, `move_nodes`, `set_node_flags`: inspecionar e ajustar. `create_page`, `rename_page` e `delete_page` organizam as páginas.
6. `save_document` (o autosave também salva após 800 ms sem edições). Screenshot para conferir visualmente chega na tarefa 3.

## Formato do resumo da árvore

Uma linha por nó, indentada por nível: `id "nome" tag [dimensões] [layout] [atributos relevantes]`.

```
fr_ab12 "Hero" div 1440x800 flex-col gap:24 p:64 bg:#111
  tx_9f3k "Título" h1 "Bem-vindo…" 48px/700
  tx_2m8x "Subtítulo" p "Crie mockups com IA" 18px/400
  el_7q1c "CTA" button 160x48 bg:var(--color-primary)
```

Abreviações: `flex-col`/`flex-row` (direção), `gap:`, `p:` (padding), `bg:` (fundo), `48px/700` (tamanho/peso da fonte). Texto longo é truncado com `…`. Filhos além da profundidade pedida aparecem como contagem.

## Ferramentas

### Leitura

| Ferramenta         | Parâmetros                                                                                            | Descrição                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `get_basic_info`   | nenhum                                                                                                | Arquivo, id, alterado, revisão, páginas/frames (id, nome, tamanho, posição), documentos abertos e seleção. |
| `list_documents`   | nenhum                                                                                                | Documentos abertos (`docId`, nome, caminho, `dirty`).                                                      |
| `open_document`    | `path` (string, obrigatório)                                                                          | Abre um `*.mockup.json` e o torna ativo.                                                                   |
| `create_document`  | `path` (string, obrigatório), `name` (string, obrigatório)                                            | Cria um documento novo no caminho dado e o torna ativo.                                                    |
| `save_document`    | `docId` (string)                                                                                      | Salva em disco.                                                                                            |
| `close_document`   | `docId` (string, obrigatório)                                                                         | Fecha o documento.                                                                                         |
| `get_selection`    | `docId` (string)                                                                                      | Ids selecionados no editor.                                                                                |
| `get_node_info`    | `nodeId` (string, obrigatório), `docId` (string)                                                      | Tipo, tag, nome, atributos, estilos, texto, flags e posição.                                               |
| `get_children`     | `nodeId` (string, obrigatório), `docId` (string)                                                      | Filhos diretos (resumo).                                                                                   |
| `get_tree_summary` | `nodeId` (string), `depth` (number, padrão 2), `docId` (string)                                       | Resumo da árvore a partir do nó. Sem `nodeId`, resume o documento inteiro (todas as páginas).              |
| `get_styles`       | `nodeIds` (string[], obrigatório), `docId` (string)                                                   | Estilos efetivos de cada nó (herdados, com `var()` resolvido).                                             |
| `get_html`         | `nodeId` (string, obrigatório), `mode` (`'inline'` \| `'classes'`, padrão `inline`), `docId` (string) | HTML do nó; `classes` separa o CSS em classes.                                                             |
| `get_tokens`       | `docId` (string)                                                                                      | Tokens (variáveis CSS) do documento.                                                                       |
| `get_guide`        | `topic` (`getting-started` \| `layout` \| `responsive` \| `tokens`, obrigatório)                      | Texto de orientação para o agente.                                                                         |

### Escrita

| Ferramenta        | Parâmetros                                                                                                                                                  | Descrição                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_frame`    | `name` (string, obrig.), `width` (number, obrig.), `height` (number, obrig.), `pageId` (string), `x` (number), `y` (number), `styles` (objeto CSS), `docId` | Cria um frame (artboard) na página.                                                                                                                                                                                                                                                                                                            |
| `write_html`      | `html` (string, obrig.), `mode` (`'append'` \| `'replace'` \| `'replace-children'`, padrão `append`), `parentId` (string), `css` (string), `docId`          | Converte HTML em nós. `append` adiciona ao pai; `replace` substitui o nó `parentId` (em frame raiz exige um único elemento de topo, que vira o frame e herda posição, largura, altura e nome do antigo; com vários, use `replace-children`); `replace-children` substitui seus filhos. `css` aceita regras de classes aplicadas aos elementos. |
| `create_node`     | `parentId` (string, obrig.), `tag` (string, obrig.), `styles` (objeto), `text` (string), `index` (number), `name` (string), `docId`                         | Cria um nó único.                                                                                                                                                                                                                                                                                                                              |
| `update_styles`   | `nodeIds` (string[], obrig.), `styles` (objeto CSS), `unset` (string[]), `docId`                                                                            | Define e/ou remove propriedades CSS. Informe `styles` e/ou `unset`; valor `""` em `styles` remove a propriedade.                                                                                                                                                                                                                               |
| `set_text`        | `nodeIds` (string[], obrig.), `content` (string), `contents` (string[]), `docId`                                                                            | Define o texto; `content` vale para todos, `contents` é um texto por nó.                                                                                                                                                                                                                                                                       |
| `set_attrs`       | `nodeIds` (string[], obrig.), `attrs` (objeto), `unset` (string[]), `docId`                                                                                 | Define e/ou remove atributos HTML.                                                                                                                                                                                                                                                                                                             |
| `set_tag`         | `nodeIds` (string[], obrig.), `tag` (string, obrig.), `docId`                                                                                               | Troca a tag HTML dos nós. Recusa: tags bloqueadas (`script`, `style`, `iframe`, `math`, `template`, `noscript`...); `img`/`svg` fora dos nós `image`/`svg` (que só aceitam a própria tag); tags void (`br`, `hr`, `input`...) em nós de texto ou com filhos.                                                                                   |
| `rename_nodes`    | `nodeIds` (string[], obrig.), `names` (string[], obrig.), `docId`                                                                                           | Renomeia camadas (um nome por nó).                                                                                                                                                                                                                                                                                                             |
| `move_nodes`      | `nodeIds` (string[], obrig.), `parentId` (string ou null), `pageId` (string), `index` (number), `docId`                                                     | Muda o pai e/ou a ordem. Sem `parentId`, apenas reordena. `parentId: null` move para a raiz da página `pageId` (padrão: a do primeiro nó); sem posição, o nó fica à direita do último frame. O tipo do nó não muda.                                                                                                                            |
| `duplicate_nodes` | `nodeIds` (string[], obrig.), `docId`                                                                                                                       | Duplica; devolve o mapa de ids antigos para novos.                                                                                                                                                                                                                                                                                             |
| `delete_nodes`    | `nodeIds` (string[], obrig.), `docId`                                                                                                                       | Remove nós e descendentes.                                                                                                                                                                                                                                                                                                                     |
| `set_position`    | `nodeId` (string, obrig.), `x` (number, obrig.), `y` (number, obrig.), `docId`                                                                              | Posição no canvas (frame) ou x/y de filho `position: absolute`.                                                                                                                                                                                                                                                                                |
| `create_page`     | `name` (string, obrig.), `docId`                                                                                                                            | Cria uma página.                                                                                                                                                                                                                                                                                                                               |
| `rename_page`     | `pageId` (string, obrig.), `name` (string, obrig.), `docId`                                                                                                 | Renomeia uma página.                                                                                                                                                                                                                                                                                                                           |
| `delete_page`     | `pageId` (string, obrig.), `docId`                                                                                                                          | Remove a página e seus frames (undo reverte). Não exclui a última página.                                                                                                                                                                                                                                                                      |
| `set_node_flags`  | `nodeIds` (string[], obrig.), `hidden` (boolean), `locked` (boolean), `docId`                                                                               | Oculta/exibe e bloqueia/desbloqueia nós. Informe ao menos um dos dois.                                                                                                                                                                                                                                                                         |
| `set_tokens`      | `tokens` (objeto `--nome: valor`, obrig.), `unset` (lista de nomes), `docId`                                                                                | Define ou atualiza tokens.                                                                                                                                                                                                                                                                                                                     |
| `set_selection`   | `nodeIds` (string[], obrig.), `docId`                                                                                                                       | Seleciona nós no editor.                                                                                                                                                                                                                                                                                                                       |
| `undo`            | `docId`                                                                                                                                                     | Desfaz a última operação.                                                                                                                                                                                                                                                                                                                      |
| `redo`            | `docId`                                                                                                                                                     | Refaz.                                                                                                                                                                                                                                                                                                                                         |

### Exemplo: criar frame e conteúdo

Chamada:

```json
{
  "name": "create_frame",
  "arguments": {
    "name": "Hero",
    "width": 1440,
    "height": 800,
    "styles": {
      "display": "flex",
      "flex-direction": "column",
      "gap": "24px",
      "padding": "64px",
      "background": "#111"
    }
  }
}
```

Resposta (texto):

```
Frame criado: fr_ab12
fr_ab12 "Hero" div 1440x800 flex-col gap:24 p:64 bg:#111
```

Chamada:

```json
{
  "name": "write_html",
  "arguments": {
    "parentId": "fr_ab12",
    "html": "<h1 style=\"font-size:48px;font-weight:700;color:#fff\">Bem-vindo</h1><p style=\"color:var(--color-muted)\">Crie mockups com IA</p>"
  }
}
```

Resposta:

```
2 nós criados
fr_ab12 "Hero" div 1440x800 flex-col gap:24 p:64 bg:#111
  tx_9f3k "Título" h1 "Bem-vindo" 48px/700
  tx_2m8x "Texto" p "Crie mockups com IA" 16px/400
```

### Exemplo: ajustar estilos

```json
{
  "name": "update_styles",
  "arguments": { "nodeIds": ["tx_9f3k"], "styles": { "font-size": "56px" }, "unset": ["color"] }
}
```

## Resources

Os guias também são publicados como resources:

| URI                       | Conteúdo                   |
| ------------------------- | -------------------------- |
| `guide://getting-started` | Como começar.              |
| `guide://layout`          | Layout com flex e frames.  |
| `guide://responsive`      | Frames como breakpoints.   |
| `guide://tokens`          | Tokens como variáveis CSS. |

## Em breve (tarefa 3)

- `get_screenshot`: imagem de um nó ou frame para o agente conferir o resultado visualmente.
- `export`: exportação de nós em PNG, JPG, SVG e código.
- `get_code`: código HTML, Tailwind ou React de um nó.

Veja o plano completo em [PLANO.md](PLANO.md).
