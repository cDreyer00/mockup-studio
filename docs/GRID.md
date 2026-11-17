# CSS Grid

Grid is first-class layout: styles are real CSS (`display:grid`), rendered by Chromium and exported without transformation.

## Supported styles

- Container: `display: grid | inline-grid`, `grid-template-columns`, `grid-template-rows` (`fr`, `px`, `%`, `auto`, `minmax()`, `repeat(n, ...)`, `repeat(auto-fill|auto-fit, ...)`, `fit-content()`), `gap` / `column-gap` / `row-gap`, `grid-template-areas`, `place-items`, `justify-items`, `align-items`, `grid-auto-flow`.
- Children: `grid-column`, `grid-row` (`2`, `2 / span 2`, `span 2`), `grid-area` (named area).
- Works in `write_html` (HTML + CSS), `create_node`, `update_styles` and the tools below.

## MCP tools

- `set_grid(nodeId, columns, rows?, gap?, columnGap?, rowGap?, areas?, placeItems?, justifyItems?, alignItems?, autoFlow?)`. `columns`/`rows` accept a number (`3` = `repeat(3, minmax(0, 1fr))`), CSS text or a list of tracks. `areas` is validated: all rows must have the same number of cells, names must be valid (`.` = empty) and each area must be a rectangle.
- `place_in_grid(nodeIds, column, row, span?, columnSpan?, rowSpan?, area?)`. Lines start at 1. `span` is a number (columns) or `{ columns, rows }`. The parent must be a grid; otherwise the message suggests `set_grid`.
- `get_layout(nodeId)` (needs a render) returns, for each grid container, the measured column and row tracks (position and size in px), so you can check where each cell landed.

```
set_grid({ nodeId: "el_main", columns: "240px 1fr", rows: "64px 1fr", gap: 16, areas: ["side top", "side content"] })
place_in_grid({ nodeIds: ["el_sidebar"], area: "side" })
place_in_grid({ nodeIds: ["el_card"], column: 2, row: 2, span: { columns: 2, rows: 1 } })
```

See `get_guide('grid')` for tips (`minmax`, `auto-fill`, implicit tracks).

## Editor

- **Layout** panel with the **Grid** mode: columns, rows, gap, areas and alignment of the selected container.
- **Track overlay**: with a grid container selected, the canvas draws the lines and sizes of the measured tracks.
- **Drag to cell**: dropping a child onto a grid cell positions it (`grid-column`/`grid-row`).
- **Span handles**: drag the edges of the selected child to occupy more columns or rows.

## Export

`html`, `tailwind` and `react` keep the grid: the HTML comes out with the `display:grid` styles, tracks and placement; Tailwind converts whatever has an equivalent class (`grid`, `grid-cols-3`, `col-span-2`, `gap-4`) and uses arbitrary values (`grid-cols-[1fr_200px]`) for the rest. SVG/PNG use the real measurements from the render.

Tracks in Tailwind: `grid-cols-N`/`grid-rows-N` are only emitted for `repeat(N, minmax(0, 1fr))`, which is exactly what those classes generate (and what `set_grid` writes for `columns: 3`). `repeat(N, 1fr)` has an `auto` minimum (the track grows with its content) and therefore becomes an arbitrary value, `grid-cols-[repeat(3,1fr)]`. Before this phase, `repeat(N, 1fr)` also became `grid-cols-N`.
