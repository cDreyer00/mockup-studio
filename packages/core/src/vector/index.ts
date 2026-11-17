/**
 * Vetores: modelo editável de nós `svg` (paths, formas, booleanas, achatar).
 *
 * CONTRATO (assinaturas estáveis usadas pelo servidor e pelo editor). As implementações ficam nos
 * módulos deste diretório; este índice só reexporta.
 *
 * Regras do modelo:
 * - `node.svg` é sempre o markup renderizado/exportado. Com `node.vector`, `node.svg` ===
 *   `vectorToSvg(node.vector)`.
 * - Importar SVG (`svgToVector`) guarda o markup sanitizado em `raw`, intacto, e extrai `paths`
 *   quando o SVG é simples. Enquanto `raw` existe, `vectorToSvg` devolve `raw`.
 * - Qualquer edição de paths/viewBox/tinta (`editVector`, `setVectorPaint`...) remove `raw` e o
 *   markup passa a ser regenerado (`generateVectorSvg`).
 * - Nós svg antigos (write_html, insert_icon) não têm `vector`; `ensureVector` o cria sob demanda.
 */
export * from './path.js';
export * from './anchors.js';
export * from './svg.js';
export * from './shapes.js';
export * from './fit.js';
export * from './boolean.js';
export * from './build.js';
