import type { CSSProperties } from 'react';
import type { Node } from '@mockup/core';

/** Props comuns das views de mídia do canvas. */
export interface FxViewProps {
  node: Node;
  /** Estilo final do nó (`buildNodeStyle`). */
  style: CSSProperties;
  docId: string;
}

/** Estilo do elemento raiz de uma view de mídia. */
export const fxRootStyle = (style: CSSProperties): CSSProperties => ({
  ...style,
  overflow: 'hidden',
});

/** Conteúdo interno: preenche o box e não rouba cliques do canvas. */
export const FX_INNER: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  border: 0,
  pointerEvents: 'none',
};
