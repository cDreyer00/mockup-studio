import type { LayoutNode } from '../layout.js';
import type { Document } from '../types.js';

export interface SvgExportOptions {
  nodeId: string;
  /**
   * Geometria medida pela página de render (`measure(nodeId)`). Sem ela, o SVG cai para um
   * `<foreignObject>` com o HTML exportado, do tamanho declarado no estilo do nó.
   */
  layout?: LayoutNode;
  /** Resolve o `src` de imagens (relativo a `assets/`) para data URL; `undefined` mantém o src. */
  resolveImage?: (src: string) => string | undefined;
}

/** SVG standalone do nó (rects com raio, borda e sombra; textos posicionados; imagens embutidas). */
export function exportSvg(_doc: Document, _options: SvgExportOptions): string {
  throw new Error('exportSvg: não implementado');
}
