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
- `docId` é opcional; quando omitido, vale o documento ativo (exceto em `close_document`, que o exige).
- Estilos são CSS real em kebab-case (`"padding": "24px"`). Tokens são variáveis CSS usadas via `var(--color-primary)`.
- Ids têm prefixo por tipo: `fr_`, `el_`, `tx_`, `im_`, `sv_`, `pg_`, `doc_`.
- Erros voltam como resultado de ferramenta com `isError` e mensagem em texto (veja [Erros](#erros)).
- O servidor envia `instructions` no handshake (ver [Instruções do servidor](#instruções-do-servidor)).

## Instruções do servidor

No `initialize`, o servidor devolve `instructions` curtas para o cliente colocar no contexto do agente: o que é o app, começar com `get_guide('getting-started')` e `get_basic_info`, definir tokens antes de desenhar, preferir `write_html`, conferir sempre com `get_screenshot`, `docId` opcional e chamar `finish_working` ao terminar. O proxy stdio do CLI (`mockup mcp`) repassa essas instruções ao cliente.

## Fluxo típico

1. `get_basic_info` e `get_guide('getting-started')`: estado do app e regras de uso.
2. `create_document` ou `open_document`.
3. `get_tokens` / `set_tokens`: definir cores, fontes e espaçamentos.
4. `create_frame` (artboard) e `write_html` para montar o conteúdo.
5. `get_tree_summary`, `get_styles`, `update_styles`, `set_text`, `set_tag`, `move_nodes`, `set_node_flags`: inspecionar e ajustar. `create_page`, `rename_page` e `delete_page` organizam as páginas.
6. `save_document` (o autosave também salva após 800 ms sem edições).
7. `get_screenshot` depois de cada conjunto de mudanças, corrigir e repetir (ver [Ver o resultado](#ver-o-resultado)); ao terminar, `finish_working`.

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

| Ferramenta         | Parâmetros                                                                                                                                               | Descrição                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_basic_info`   | nenhum                                                                                                                                                   | Arquivo, id, alterado, revisão, páginas/frames (id, nome, tamanho, posição), documentos abertos e seleção.                                         |
| `list_documents`   | nenhum                                                                                                                                                   | Documentos abertos (`docId`, nome, caminho, `dirty`).                                                                                              |
| `open_document`    | `path` (string, obrigatório)                                                                                                                             | Abre um `*.mockup.json` e o torna ativo.                                                                                                           |
| `create_document`  | `path` (string, obrigatório), `name` (string, obrigatório)                                                                                               | Cria um documento novo no caminho dado e o torna ativo.                                                                                            |
| `save_document`    | `docId` (string)                                                                                                                                         | Salva em disco.                                                                                                                                    |
| `close_document`   | `docId` (string, obrigatório)                                                                                                                            | Fecha o documento.                                                                                                                                 |
| `get_selection`    | `docId` (string)                                                                                                                                         | Ids selecionados no editor.                                                                                                                        |
| `get_node_info`    | `nodeId` (string, obrigatório), `docId` (string)                                                                                                         | Tipo, tag, nome, atributos, estilos, texto, flags e posição.                                                                                       |
| `get_children`     | `nodeId` (string, obrigatório), `docId` (string)                                                                                                         | Filhos diretos (resumo).                                                                                                                           |
| `get_tree_summary` | `nodeId` (string), `depth` (number, padrão 2), `docId` (string)                                                                                          | Resumo da árvore a partir do nó. Sem `nodeId`, resume o documento inteiro (todas as páginas).                                                      |
| `get_styles`       | `nodeIds` (string[], obrigatório), `docId` (string)                                                                                                      | Estilos efetivos de cada nó (herdados, com `var()` resolvido).                                                                                     |
| `get_html`         | `nodeId` (string, obrigatório), `mode` (`'inline'` \| `'classes'`, padrão `inline`), `docId` (string)                                                    | HTML do nó; `classes` separa o CSS em classes.                                                                                                     |
| `get_tokens`       | `docId` (string)                                                                                                                                         | Tokens (variáveis CSS) do documento.                                                                                                               |
| `get_guide`        | `topic` (`getting-started` \| `design-system` \| `layout` \| `responsive` \| `screenshot-loop` \| `export` \| `troubleshooting` \| `setup`, obrigatório) | Guia em markdown para o agente (fluxo em 6 passos, design system, layout, breakpoints, screenshot, exportação, problemas comuns, registro do MCP). |

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
| `set_tokens`      | `tokens` (objeto `--nome: valor`, obrig.), `unset` (lista de nomes), `docId`                                                                                | Define ou atualiza tokens. Nomes sem `--` ganham o prefixo (`primary` vira `--primary`).                                                                                                                                                                                                                                                       |
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

## Ver o resultado

O agente precisa **ver** o que criou. O ciclo recomendado (`get_guide('screenshot-loop')`):

1. Criar ou editar (`write_html`, `update_styles`, `insert_image`...).
2. `get_screenshot(nodeId)` e conferir: alinhamento, cortes, overflow, contraste, textos quebrando.
3. Corrigir e repetir o passo 2.
4. `finish_working` ao terminar, para apagar o indicador "IA" no editor.

Prefira `scale` 1 e `maxWidth` (ex.: 800) para gastar menos contexto; `get_layout` dá as medidas exatas em números.

**Quando o render está disponível:** `get_screenshot`, `get_layout`, `export` png/jpg e o SVG medido dependem do motor de render (Electron): no app desktop ou no Electron headless que o `mockup mcp` sobe quando o Electron está instalado. Num daemon Node puro essas ferramentas devolvem `isError` explicando como habilitar (`export` svg/html/tailwind/react e `get_code` continuam funcionando; o SVG usa um fallback sem medidas).

### Render e finalização

| Ferramenta       | Parâmetros                                                                                                                                                                                          | Descrição                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_screenshot` | `nodeId` (string; padrão: primeiro nó selecionado ou primeiro frame), `scale` (1, 2 ou 3; padrão 1), `format` (`png` \| `jpg`, padrão `png`), `maxWidth` (number), `transparent` (boolean), `docId` | Devolve a imagem (conteúdo `image` em base64) e um texto: `fr_x "Desktop 1440": 1440x900 px (imagem 1440x900 png, 182 KB)`.                                                             |
| `get_layout`     | `nodeId` (string, obrig.), `depth` (number, padrão 3), `docId`                                                                                                                                      | Medidas reais, uma linha por nó indentada: `id "nome" tag x,y wxh` (px inteiros, relativos ao frame) e o texto das linhas nos nós de texto; filhos além da profundidade viram contagem. |
| `finish_working` | `nodeIds` (string[]; padrão: documento inteiro), `docId`                                                                                                                                            | Emite `agent:finished`: o editor apaga o badge "IA". Chame ao terminar um conjunto de edições.                                                                                          |

## Exportação e código

| Ferramenta | Parâmetros                                                                                                                                                                                                      | Descrição                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export`   | `nodeIds` (string[], obrig.), `format` (`png` \| `jpg` \| `svg` \| `html` \| `tailwind` \| `react`, obrig.), `scale` (1 a 3), `outputDir` (caminho absoluto), `styles` (`tailwind` \| `inline`, react), `assetsBase` (só react), `docId` | Grava um arquivo por nó, com o slug do nome (`desktop-1440.png`, `.svg`, `.html`, `.tailwind.html`; react: `<Componente>.tsx` e `theme.css` ou `<Componente>.css`). Padrão de `outputDir`: `<pasta do documento>/exports/`; documento sem caminho exige `outputDir`. Em html/tailwind/react copia imagens e fontes usadas para `<outputDir>/assets/`. Arquivos de mesmo nome em `outputDir` são sobrescritos; a resposta marca os substituídos com `(substituído)`. Devolve os caminhos e, para código, o conteúdo até 20 KB no total (o que passar disso só fica nos arquivos; use `get_code`). `assetsBase` (só react, padrão `assets/`) é o prefixo das URLs de imagens e fontes: num projeto Vite com `public/assets/`, use `/assets/`. |
| `get_code` | `nodeId` (string, obrig.), `format` (`html` \| `tailwind` \| `react`, obrig.), `styles` (`tailwind` \| `inline`, react), `assetsBase` (só react), `docId`                                                                                | Devolve o código sem gravar: fragmento + CSS necessário (html/tailwind) ou o `.tsx` e o CSS do componente (react).                                                                                                                                                                                                                                                                                                                                                                                                                           |

Use `get_code` para ler ou colar um trecho; use `export` para entregar arquivos (com assets). Detalhes em `get_guide('export')`.

## Imagens, ícones e fontes

| Ferramenta      | Parâmetros                                                                                                     | Descrição                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insert_image`  | `parentId` (obrig.), `source` (obrig.), `alt`, `styles`, `name`, `index`, `docId`                              | `source`: caminho local absoluto, URL http(s) (timeout 20 s, até 20 MB, content-type de imagem) ou data URL. Valida pelos bytes (PNG, JPEG, GIF, WebP, SVG, AVIF), copia para `assets/` (sem sobrescrever: `-1`, `-2`) e cria o nó `img`. Sem `width` usa o tamanho intrínseco. Documento sem caminho: embute como data URL (até 2 MB).                                                                                                                                                                                                                                                               |
| `insert_icon`   | `parentId` (obrig.), `name` (obrig.), `size` (padrão 24), `color`, `stroke_width` (padrão 2), `index`, `docId` | Ícone [Lucide](https://lucide.dev) como nó `svg` (kebab-case ou PascalCase). Sem `color` usa a cor de texto efetiva do pai (fallback `#111111`), pois o canvas desenha SVG isolado e `currentColor` não herda. Nome inexistente: erro com até 5 sugestões.                                                                                                                                                                                                                                                                                                                                            |
| `search_icons`  | `query` (obrig.), `limit` (padrão 20)                                                                          | Busca por nome e tags; devolve nomes kebab-case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `list_fonts`    | `query`, `limit` (padrão 50), `docId`                                                                          | Fontes do documento (embutidas/locais) e do sistema (Windows: registro; macOS: `system_profiler`; Linux: `fc-list`), com cache em memória.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_font_info` | `family` (obrig.), `docId`                                                                                     | Instalada no sistema (estilos e arquivos)? Embutida no documento (arquivos e pesos)? Como usar em `font-family`, com fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `add_font`      | `family` (obrig.), `source` (obrig.), `weights`, `docId`                                                       | `source`: `google` (baixa agora da API CSS2 o subconjunto latin; pesos padrão 400 e 700), `local` (fonte instalada; só registra), caminho de arquivo ou pasta (`.woff2`, `.woff`, `.ttf`, `.otf`) ou URL http(s) de um arquivo. Arquivos vão para `assets/fonts/<familia>-<peso>-<estilo>-<hash8>.<ext>` (nome único pelo conteúdo, nunca sobrescreve; a URL muda sozinha quando a fonte muda). Com vários formatos do mesmo peso/estilo fica um só (woff2 > woff > ttf/otf). Re-adicionar a família troca a entrada em `doc.fonts` (undo funciona) e mantém os arquivos antigos. Sem CDN em runtime. |

## Importação de sites

Trazem seções de sites reais como nós editáveis (HTML/CSS com os estilos computados reduzidos), não como imagem. Guia: `get_guide('import')`; detalhes, extensão de navegador e limitações em [SNAPSHOT.md](SNAPSHOT.md).

| Ferramenta         | Parâmetros                                                                                                                                                                                                                           | Descrição                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `import_url`       | `url` (http/https, obrig.), `selector` (padrão `body`), `width` (320 a 3840, padrão 1440), `height` (200 a 4000, padrão 900), `timeout_ms` (até 60000, padrão 20000), `name`, `reference` (padrão true), `pageId`, `x`, `y`, `docId` | Abre a página no Electron headless (janela e sessão isoladas, `file://` e o próprio daemon bloqueados), captura o elemento do seletor e cria um frame com os nós, as imagens em `assets/` e as fontes em `doc.fonts`, mais um frame oculto "Referência" com a captura de tela. Uma entrada no histórico. Precisa do motor de render (senão `isError`). |
| `import_html`      | `html` (obrig.), `css`, `assets_base_url` (base http(s) para URLs relativas), `selector`, `width`, `height`, `timeout_ms`, `name`, `reference`, `pageId`, `x`, `y`, `docId`                                                          | HTML completo (com `<style>`/`<link>`) renderizado da mesma forma que `import_url`. Sem render, converte com o parser do core (sem estilos computados, altura do frame = viewport) e avisa.                                                                                                                                                            |
| `cleanup_imported` | `nodeId` (obrig.), `remove_empty`, `unwrap`, `fluid` (todos padrão true), `docId`                                                                                                                                                    | Simplifica um frame importado: remove wrappers vazios, desembrulha wrappers neutros com um único filho, troca `width` em px igual ao do pai por auto e `height` em px de blocos com conteúdo por `min-height`. Uma entrada no histórico; "Nada a limpar" quando não há o que mudar.                                                                    |

Resposta de `import_url`/`import_html` (texto):

```
Importado de http://localhost:5500/: fr_ab12cd34 "Hero" (42 nós, 2 imagens, fontes: Inter). Referência oculta: fr_9f8e7d6c.
fr_ab12cd34 "Hero" section 1440x640 ...
  ...
Próximos passos: confira com get_screenshot(fr_ab12cd34) e simplifique com cleanup_imported(fr_ab12cd34). Para comparar com o original: set_node_flags em fr_9f8e7d6c com hidden:false (ou get_screenshot dele).
```

Fluxo sugerido: `import_url` → `get_screenshot` do frame (compare com o frame "Referência", que pode ser exibido com `set_node_flags`) → `cleanup_imported` → `get_screenshot` de novo → extrair as cores repetidas em tokens (`set_tokens` + `update_styles` com `var(--...)`). A extensão de navegador e o colar no editor (Ctrl+V) usam o mesmo pipeline pela rota `POST /api/snapshot`.

## Erros

Falhas de uso voltam como resultado de ferramenta com `isError: true` (não como erro de protocolo). Erros de parâmetro são reformatados em português: um item por campo (obrigatório ausente, tipo esperado x recebido, valor fora das opções, mínimo/máximo) e uma chamada de exemplo.

```
Parâmetros inválidos em create_frame:
- width: obrigatório e ausente (esperado: número (number)).
- height: tipo incorreto: esperado número (number), recebido texto (string) "900px".
Exemplo: create_frame({"name":"Desktop","width":1440,"height":900})
```

Ferramenta inexistente: `Ferramenta "write_htm" não existe. Ferramentas parecidas: write_html, ...`. Erros de ids e de estado (nó não encontrado, nenhum documento aberto, render indisponível) dizem qual ferramenta usar em seguida; `get_guide('troubleshooting')` reúne as soluções.

## Resources

Os guias também são publicados como resources (`text/markdown`), um por tópico de `get_guide`:

| URI                       | Conteúdo                                                                 |
| ------------------------- | ------------------------------------------------------------------------ |
| `guide://getting-started` | Fluxo em 6 passos, dicas e lista de guias.                               |
| `guide://design-system`   | Tokens como variáveis CSS, escalas de espaço e tipografia, contraste AA. |
| `guide://layout`          | Layout com flex, tamanhos e posição absoluta.                            |
| `guide://responsive`      | Frames `Mobile`, `Tablet` e `Desktop` como breakpoints.                  |
| `guide://screenshot-loop` | Ciclo criar, conferir com screenshot, corrigir.                          |
| `guide://export`          | Formatos de exportação, pasta de saída e assets.                         |
| `guide://troubleshooting` | Render indisponível, nó não encontrado, porta ocupada, overflow e logs.  |
| `guide://setup`           | Instalar o CLI e registrar o MCP (Claude Code, Codex, Cursor, VS Code).  |
| `guide://import`          | Importar sites: extensão, `import_url`, `import_html` e limpeza.         |

Veja o plano completo em [PLANO.md](PLANO.md).
