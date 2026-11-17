/**
 * Vectors: editable model of `svg` nodes (paths, shapes, booleans, flatten).
 *
 * CONTRACT (stable signatures used by the server and the editor). The implementations live in the
 * modules of this directory; this index only re-exports.
 *
 * Model rules:
 * - `node.svg` is always the rendered/exported markup. With `node.vector`, `node.svg` ===
 *   `vectorToSvg(node.vector)`.
 * - Importing SVG (`svgToVector`) stores the sanitized markup in `raw`, intact, and extracts `paths`
 *   when the SVG is simple. While `raw` exists, `vectorToSvg` returns `raw`.
 * - Any edit of paths/viewBox/paint (`editVector`, `setVectorPaint`...) removes `raw` and the
 *   markup is regenerated (`generateVectorSvg`).
 * - Old svg nodes (write_html, insert_icon) have no `vector`; `ensureVector` creates it on demand.
 */
export * from './path.js';
export * from './anchors.js';
export * from './svg.js';
export * from './shapes.js';
export * from './fit.js';
export * from './boolean.js';
export * from './build.js';
