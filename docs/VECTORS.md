# Vectors

Shapes, icons and imported SVG are `svg` nodes. What makes an svg node editable (points, paint, boolean operations) is the `Node.vector` field.

## Model

```ts
interface Vector {
  viewBox: { x; y; width; height };
  paths: VectorPath[]; // id, d, fill, stroke, strokeWidth, opacity, linecap, linejoin, dasharray, fillRule
  raw?: string; // original sanitized markup
  attrs?: Record<string, string>; // extra attributes of the root <svg>
}
```

- `node.svg` is always the rendered and exported markup. With `node.vector`, `node.svg === vectorToSvg(vector)`.
- **raw vs. paths**: when importing an SVG (`insert_svg`, pasting markup in the editor), the sanitized markup is kept intact in `raw`, and the `paths` are extracted when the SVG is simple. While `raw` exists, the displayed markup is the original.
- **When it is editable**: only with non-empty `paths`. An SVG is "simple" if it uses only `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` and linear/radial gradients with `stop`. Filters, masks, `clipPath`, `use`, text, images, `fill-opacity`, group opacity and markers leave `paths` empty: the SVG is still displayed and exported, but it is not editable.
- **Regeneration**: any edit to paths, viewBox or paint removes `raw`; the markup is then generated from the paths (`<svg viewBox width="100%" height="100%">` with one `<path>` per item and gradients in `<defs>`).
- Older svg nodes (from `write_html` or `insert_icon`) have no `vector`; it is created on the first edit (and `get_svg` infers the paths without saving).
- The `setVector` op validates the vector and updates `node.svg`; undo restores the previous one.

## Shapes

`rect`, `ellipse`, `line`, `polygon` (3 to 64 sides) and `star` (3 to 64 points, `innerRatio` from 0.05 to 0.95). Each one is a `p1` path in the `0 0 w h` viewBox (the line gets half the stroke width as slack so it is not clipped). Default paint: `fill #d9d9d9`; line `stroke #111111` with width 2.

## Boolean operations and flatten

`union`, `subtract` (the bottommost node minus the ones above it), `intersect` and `exclude` (xor), between 2 or more sibling svgs. Curves are flattened into segments before the operation (tolerance 0.25), so the result is polygonal. The result takes the place of the first node, with the paint of its first path, and the originals are removed. `flatten` merges a node's paths into one, or combines several sibling svgs into one node that keeps each path's paint.

### Position, scale and preserveAspectRatio

Each path is brought into the parent's space through the node's box and the viewBox, the way the browser draws it:

- **Position.** Free nodes, that is, root frames of the page or nodes with `position: absolute|fixed`, use the style (`left`/`top`; on the root, `node.position`; an absolute child without left/top falls back to `node.position`). In-flow nodes (without absolute position) have no position in the style: the editor measures the box in the DOM (relative to the parent's padding box, corrected by the zoom) and the MCP server measures the parent with the render engine (`get_layout`). Without a measurement (no render in the MCP server, or a node outside the canvas) the operation is rejected with "Node X is in flow (no position: absolute); position it freely before ...".
- **Result.** In a regular parent the new node is `position: absolute` with left/top/width/height; if any in-flow node was used and the parent is static, the parent becomes `position: relative` (in the same undo entry). The remaining siblings reflow, since the result leaves the flow. On the page root the result uses `node.position`, like any root frame.
- **preserveAspectRatio.** Generated vectors (shapes, boolean operations) are stretched (`none`): independent x and y scales. Imported vectors follow the SVG's `preserveAspectRatio` (default `xMidYMid meet`): uniform scale (the smaller one for `meet`, the larger for `slice`) and alignment offset (`xMin|xMid|xMax` and `YMin|YMid|YMax`). The `slice` clipping is not applied.
- **Stroke.** `strokeWidth` and `strokeDasharray` are multiplied by the matrix scale (`hypot(a, b)`): a 24x24 icon displayed at 48px with stroke 2 comes out with stroke 4, and the `2 1` dash becomes `4 2`. Flattening a single node (`setVector` on the node itself) does not change the scale. The extra space around the result uses the already scaled stroke.

## Text to outlines

Converts text nodes into svg with the glyphs as paths (opentype.js; WOFF2 via `woff2-encoder`). The font comes first from the document's fonts (`assets/fonts`), then from the fonts installed on the system; variable fonts respect the weight. The text stops being editable as text. The result includes notes (font used, line breaks, missing glyphs). Undo gives the text back.

## MCP tools

`create_shape`, `set_path`, `insert_svg`, `get_svg`, `set_vector_paint`, `boolean_op`, `flatten`, `text_to_outlines` (details in `docs/MCP.md`, section "Vectors and grid"). Lucide icons (`insert_icon`) also accept `get_svg` and `set_vector_paint`. Example:

```
create_shape({ parentId: "fr_ab12cd34", shape: "star", x: 40, y: 40, width: 120, height: 120, styles: { fill: "#f5c518" } })
set_vector_paint({ nodeId: "sv_ab12cd34", stroke: "#111111", strokeWidth: 2 })
boolean_op({ nodeIds: ["sv_aaaa1111", "sv_bbbb2222"], op: "subtract" })
```

## Editor shortcuts

| Shortcut               | Action                                                                       |
| ---------------------- | ---------------------------------------------------------------------------- |
| `P`                    | Pen: click for straight points, drag for curves; Enter/double click finishes |
| `O`                    | Ellipse (Shift: circle)                                                      |
| `L`                    | Line (Shift: multiples of 45°)                                               |
| Polygon (toolbar)      | Polygon; Alt on release creates a star                                       |
| Double click / `Enter` | Edits the points of the selected vector (Esc exits)                          |
| `Ctrl+Shift+O`         | Text to outlines                                                             |

Boolean operations, flatten and text to outlines are also in the vector panel menu.
