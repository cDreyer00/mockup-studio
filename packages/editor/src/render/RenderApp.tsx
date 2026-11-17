import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { Document, Node } from '@mockup/core';
import { breakpointsOf, expandNodeTree } from '@mockup/core';
import type { PreviewState } from '@mockup/core';
import { DocIdContext, NodeView, RenderDocContext } from '../canvas/NodeView';
import { BASE_STATE_CTX, StateCtxContext } from '../canvas/stateContext';
import { DocumentBase, FontFaces } from '../canvas/FontFaces';
import { ThemeStyles } from '../canvas/ThemeStyles';
import '../canvas/canvas.css';

export interface RenderAppProps {
  doc: Document;
  docId: string;
  /** Root frame already adjusted for render mode (at 0,0, without shadow and visible). */
  frame: Node;
  /** State preview (hover, focus, dark...) applied to all nodes. */
  state?: PreviewState;
}

/** Prepares the frame for render mode: at (0,0), visible and without the canvas's default shadow. */
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

/** Same tree as the canvas (`NodeView`), tokens on the wrapper and embedded fonts; no label/overlay. */
export function RenderApp({ doc, docId, frame: received, state }: RenderAppProps) {
  // Tolerant of unexpanded instances (same object when there are none).
  const frame = useMemo(() => expandNodeTree(doc, received), [doc, received]);
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
