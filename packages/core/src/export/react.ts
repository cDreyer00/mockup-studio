import type { Document } from '../types.js';

export interface ReactExportOptions {
  /** Nó raiz do componente (um componente por nó). */
  nodeId: string;
  /** `tailwind` (padrão): `className` com classes Tailwind v4; `inline`: `style={{...}}`. */
  styles?: 'tailwind' | 'inline';
  /** Nome do componente (padrão: PascalCase do nome do nó). */
  componentName?: string;
  /** Extrai irmãos com a mesma estrutura em `items.map(...)` sobre um array. Padrão `true`. */
  extractRepeats?: boolean;
  /** Prefixo do `src` de imagens relativas (padrão `assets/`). */
  assetsBase?: string;
}

export interface ReactExport {
  componentName: string;
  /** Arquivo `.tsx` completo (componente funcional exportado). */
  code: string;
}

export function exportReact(_doc: Document, _options: ReactExportOptions): ReactExport {
  throw new Error('exportReact: não implementado');
}
