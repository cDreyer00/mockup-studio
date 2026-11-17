import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { Document, Node } from '@mockup/core';
import { breakpointsOf } from '@mockup/core';
import type { PreviewState } from '@mockup/core';
import { DocIdContext, NodeView, RenderDocContext } from '../canvas/NodeView';
import { BASE_STATE_CTX, StateCtxContext } from '../canvas/stateContext';
import { DocumentBase, FontFaces } from '../canvas/FontFaces';
import { ThemeStyles } from '../canvas/ThemeStyles';
import '../canvas/canvas.css';

export interface RenderAppProps {
  doc: Document;
  docId: string;
  /** Frame raiz já ajustado para o modo render (em 0,0, sem sombra e visível). */
  frame: Node;
  /** Prévia de estado (hover, focus, dark...) aplicada a todos os nós. */
  state?: PreviewState;
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
export function RenderApp({ doc, docId, frame, state }: RenderAppProps) {
  const stateCtx = useMemo(
    () => ({
      ...BASE_STATE_CTX,
      preview: state ?? null,
      breakpoints: breakpointsOf(doc),
      darkTheme: !!doc.themes?.some((t) => t.name === 'dark'),
    }),
    [state, doc],
  );
  return (
    <div
      className="cv-world"
      data-testid="render-world"
      style={doc.tokens as CSSProperties | undefined}
    >
      <DocumentBase cssBase={doc.cssBase} />
      <ThemeStyles tokens={doc.tokens} themes={doc.themes} />
      <FontFaces fonts={doc.fonts} docId={docId} />
      <DocIdContext.Provider value={docId}>
        <RenderDocContext.Provider value={doc}>
          <StateCtxContext.Provider value={stateCtx}>
            <NodeView node={frame} root />
          </StateCtxContext.Provider>
        </RenderDocContext.Provider>
      </DocIdContext.Provider>
    </div>
  );
}
