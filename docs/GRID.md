# CSS Grid

O grid é layout de primeira classe: os estilos são CSS real (`display:grid`), renderizados pelo Chromium e exportados sem transformação.

## Estilos suportados

- Contêiner: `display: grid | inline-grid`, `grid-template-columns`, `grid-template-rows` (`fr`, `px`, `%`, `auto`, `minmax()`, `repeat(n, ...)`, `repeat(auto-fill|auto-fit, ...)`, `fit-content()`), `gap` / `column-gap` / `row-gap`, `grid-template-areas`, `place-items`, `justify-items`, `align-items`, `grid-auto-flow`.
- Filhos: `grid-column`, `grid-row` (`2`, `2 / span 2`, `span 2`), `grid-area` (área nomeada).
- Vale em `write_html` (HTML + CSS), `create_node`, `update_styles` e nas ferramentas abaixo.

## Ferramentas MCP

- `set_grid(nodeId, columns, rows?, gap?, columnGap?, rowGap?, areas?, placeItems?, justifyItems?, alignItems?, autoFlow?)`. `columns`/`rows` aceitam número (`3` = `repeat(3, minmax(0, 1fr))`), texto CSS ou lista de trilhas. `areas` é validada: todas as linhas com o mesmo número de células, nomes válidos (`.` = vazio) e cada área num retângulo.
- `place_in_grid(nodeIds, column, row, span?, columnSpan?, rowSpan?, area?)`. Linhas começam em 1. `span` é número (colunas) ou `{ columns, rows }`. O pai precisa ser grid; senão a mensagem sugere `set_grid`.
- `get_layout(nodeId)` (precisa de render) devolve, para cada contêiner grid, as trilhas medidas de colunas e linhas (posição e tamanho em px), para conferir onde cada célula caiu.

```
set_grid({ nodeId: "el_main", columns: "240px 1fr", rows: "64px 1fr", gap: 16, areas: ["side top", "side content"] })
place_in_grid({ nodeIds: ["el_sidebar"], area: "side" })
place_in_grid({ nodeIds: ["el_card"], column: 2, row: 2, span: { columns: 2, rows: 1 } })
```

Veja `get_guide('grid')` para dicas (`minmax`, `auto-fill`, trilhas implícitas).

## Editor

- Painel **Layout** com o modo **Grid**: colunas, linhas, gap, áreas e alinhamento do contêiner selecionado.
- **Overlay de trilhas**: com um contêiner grid selecionado, o canvas desenha as linhas e os tamanhos das trilhas medidas.
- **Arrastar para célula**: soltar um filho sobre uma célula do grid o posiciona (`grid-column`/`grid-row`).
- **Alças de span**: arraste as bordas do filho selecionado para ocupar mais colunas ou linhas.

## Exportação

`html`, `tailwind` e `react` mantêm o grid: o HTML sai com os estilos de `display:grid`, trilhas e posicionamento; o Tailwind converte o que tem classe equivalente (`grid`, `grid-cols-3`, `col-span-2`, `gap-4`) e usa valores arbitrários (`grid-cols-[1fr_200px]`) no resto. SVG/PNG usam as medidas reais do render.

Trilhas no Tailwind: `grid-cols-N`/`grid-rows-N` só saem para `repeat(N, minmax(0, 1fr))`, que é exatamente o que essas classes geram (e o que `set_grid` grava para `columns: 3`). `repeat(N, 1fr)` tem mínimo `auto` (a trilha cresce com o conteúdo) e por isso vira valor arbitrário, `grid-cols-[repeat(3,1fr)]`. Antes desta fase, `repeat(N, 1fr)` também virava `grid-cols-N`.
