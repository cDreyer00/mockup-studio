# Dados reais

Mockups com conteúdo de verdade: listas, tabelas e grades de cards preenchidas a partir de JSON, CSV ou de uma API HTTP. O agente (ou a interface) escreve **um** item como template e liga uma lista de dados a ele; o canvas, o screenshot e o código exportado mostram um item por linha.

## Repetidor

Um repetidor é um nó `type: 'repeater'` (id `rp_...`). Ele se comporta como um contêiner comum (tem `tag`, `style` e `attrs`, então `display: grid`, `flex`, `gap` etc. valem normalmente) e guarda:

| Campo        | Tipo                    | Descrição                                                               |
| ------------ | ----------------------- | ----------------------------------------------------------------------- |
| `data`       | `unknown[]`             | Itens (até 1000 e 2 MB serializados).                                   |
| `dataSource` | `DataSource` (opcional) | De onde vieram os dados, para atualizar, e o mapeamento de campos.      |
| `children`   | `Node[]`                | O **template**: todos os filhos se repetem, em ordem, uma vez por item. |

`DataSource`:

| Campo       | Descrição                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`      | `inline` (colado ou editado na tabela), `json` ou `csv` (arquivo local) ou `url` (HTTP(S)).                                               |
| `path`      | Caminho absoluto do arquivo (`json`/`csv`).                                                                                               |
| `url`       | URL http(s) (`url`). JSON ou CSV, pelo content-type ou pela extensão.                                                                     |
| `select`    | Caminho até a lista dentro do JSON, ex.: `data.items`. Sem ele: a própria lista, ou a primeira propriedade que seja lista (até 2 níveis). |
| `mapping`   | Campo do template → caminho no item, ex.: `{ "nome": "user.fullName" }`.                                                                  |
| `limit`     | Máximo de itens lidos da origem.                                                                                                          |
| `fetchedAt` | Quando os dados foram lidos (ISO 8601).                                                                                                   |

A origem fica guardada no documento: `refresh_data` (ou o botão **Atualizar** do painel) relê o arquivo ou a URL. Não há atualização automática.

## Bindings

Em `text`, `src` e nos valores de atributos (`href`, `alt`, `title`, `aria-label`, `data-*`...) dos nós do template:

| Sintaxe                  | Resultado                                                   |
| ------------------------ | ----------------------------------------------------------- |
| `{{nome}}`               | Campo do item.                                              |
| `{{endereco.cidade}}`    | Caminho com ponto; índices de lista também (`{{fotos.0}}`). |
| `{{cargo \| Sem cargo}}` | Valor padrão quando o campo falta ou é vazio.               |
| `{{$number}}`            | Posição a partir de 1 (`{{$index}}` começa em 0).           |
| `{{$item}}`              | O item inteiro (listas de textos ou números).               |

Objetos e listas viram JSON; campo inexistente vira vazio. URLs perigosas vindas dos dados (`javascript:`, `vbscript:`, `data:text/html`) são descartadas em `href`/`src`. Estilos não aceitam bindings (`{` e `}` são recusados no CSS); para variar cor ou tamanho por item, use classes/atributos ou dados com caminhos de imagem diferentes.

## Expansão

`expandRepeaterChildren` (core, `data.ts`) gera as cópias: o item 0 mantém os ids do template e os itens seguintes ganham o sufixo `~<índice>` (`tx_ab12~3`). Esses ids existem só na expansão, nunca no documento nem em ops.

- **Canvas e página de render** (`NodeView`): o repetidor renderiza os itens expandidos; cada cópia usa `data-node-id` do nó do template, então clicar em qualquer item seleciona o nó real do template e editar o template muda todos os itens.
- **Screenshot e `get_layout`**: vêm da página de render, com os mesmos itens do canvas.
- **Exportação** (html, tailwind, react, svg): `resolveRoots` expande antes de gerar o código; o repetidor sai como o contêiner com todos os itens (no React, a extração de repetições pode virar `map`). Imagens vindas dos dados entram na cópia de assets.
- **Repetidor aninhado**: um repetidor dentro do template usa os próprios dados (não os do item externo); os ids continuam únicos.
- **Sem dados**: o template aparece uma vez, com os bindings vazios.

## Fluxo pelo MCP

1. Escreva o template com `write_html`, usando bindings:

   ```json
   {
     "name": "write_html",
     "arguments": {
       "parentId": "fr_ab12cd34",
       "html": "<div style=\"display:grid;grid-template-columns:repeat(4,1fr);gap:16px\"><article style=\"padding:16px;border-radius:12px;background:#fff\"><img src=\"{{foto}}\" alt=\"{{nome}}\" style=\"width:100%;height:120px;object-fit:cover\"><h3>{{nome}}</h3><p>{{cargo | Sem cargo}}</p></article></div>"
     }
   }
   ```

2. Ligue os dados ao contêiner com `bind_data` (ele vira repetidor; os filhos viram o template): `data` (lista inline), `path` (JSON/CSV local), `url` (HTTP) ou `text` + `format` (conteúdo colado). Opcionais: `select`, `mapping`, `limit`.
3. Confira com `get_screenshot`. `get_data` mostra a origem, as colunas, os campos do template sem coluna correspondente e as primeiras linhas.
4. `refresh_data` relê a origem depois que o arquivo ou a API mudar.

Ferramentas e parâmetros completos em [MCP.md](MCP.md#dados-reais); o guia `get_guide('data')` resume o fluxo para o agente.

## Editor

- **Painel "Dados"** (propriedades, repetidor selecionado): origem e data da leitura, **Atualizar**, **Vincular…** (colar JSON/CSV, caminho de arquivo ou URL, `select`, limite), **tabela editável** (editar célula, adicionar/remover linha e coluna; cada edição é uma op `setData`, com undo) e o **mapeamento** dos campos do template que não existem nos dados.
- **Converter em repetidor**: contêineres com filhos ganham a ação no painel e no menu de contexto.
- Camadas mostram o repetidor com o ícone de repetição; o resumo da árvore no MCP mostra `repeat:20` (e `<json`, `<csv` ou `<url` quando há origem externa).

## Op e formato

- Op `setData`: `{ type: 'setData', changes: [{ nodeId, data?, source? }] }` — `data` substitui a lista (omitido mantém), `source` define a origem (`null` remove). O inverso restaura os valores anteriores. Só vale para nós `repeater`.
- Converter um contêiner em repetidor é `deleteNodes` + `createNode` (o repetidor novo recebe os filhos com os mesmos ids), numa única entrada de undo.
- No arquivo, `dataSource` e `data` ficam depois de `hidden` e antes de `children` em cada nó.

## Leitura de JSON e CSV

- JSON: arquivo ou resposta até 5 MB; BOM ignorado; erro de sintaxe vira mensagem clara.
- CSV: RFC 4180 (aspas, aspas duplicadas, quebras de linha dentro de aspas), separador detectado pela primeira linha (`,`, `;`, tab ou `|`), primeira linha = cabeçalho (coluna sem nome vira `colN`), valores em texto.
- URL: http(s), timeout de 20 s, até 5 MB.
- Limites: 1000 itens e 2 MB serializados por repetidor.
