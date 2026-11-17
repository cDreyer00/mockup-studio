import type { CSSProperties } from 'react';
import type { Document, Node } from '@mockup/core';
import { DocIdContext, NodeView, RenderDocContext } from '../canvas/NodeView';
import { DocumentBase, FontFaces } from '../canvas/FontFaces';
import { ThemeStyles } from '../canvas/ThemeStyles';
import '../canvas/canvas.css';

export interface RenderAppProps {
  doc: Document;
  docId: string;
  /** Frame raiz já ajustado para o modo render (em 0,0, sem sombra e visível). */
  frame: Node;
}

/** Prepara o frame para o modo render: em (0,0), visível e sem a sombra padrão do canvas. */
export function renderFrameOf(frame: Node): Node {
  return {
    ...frame,
    hidden: false,
    position: { x: 0, y: 0 },
    style: {
      ...frame.style,
      ...(frame.style['box-shadow'] === undefined && { 'box-shadow': 'none' }),
    },
  };
}

/** Mesma árvore do canvas (`NodeView`), tokens no wrapper e fontes embutidas; sem rótulo/overlay. */
export function RenderApp({ doc, docId, frame }: RenderAppProps) {
  return (
    <div
      className="cv-world"
      data-testid="render-world"
      style={doc.tokens as CSSProperties | undefined}
    >
      <DocumentBase />
      <ThemeStyles tokens={doc.tokens} themes={doc.themes} />
      <FontFaces fonts={doc.fonts} docId={docId} />
      <DocIdContext.Provider value={docId}>
        <RenderDocContext.Provider value={doc}>
          <NodeView node={frame} root />
        </RenderDocContext.Provider>
      </DocIdContext.Provider>
    </div>
  );
}
