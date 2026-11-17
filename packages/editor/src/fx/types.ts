import type { CSSProperties } from 'react';
import type { Node } from '@mockup/core';

/** Common props of the canvas media views. */
export interface FxViewProps {
  node: Node;
  /** Final style of the node (`buildNodeStyle`). */
  style: CSSProperties;
  docId: string;
}

/** Style of the root element of a media view. */
export const fxRootStyle = (style: CSSProperties): CSSProperties => ({
  ...style,
  overflow: 'hidden',
});

/** Inner content: fills the box and does not steal clicks from the canvas. */
export const FX_INNER: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  border: 0,
  pointerEvents: 'none',
};
