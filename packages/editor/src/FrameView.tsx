import type { Node } from '@mockup/core';
import { NodeView } from './NodeView';

/** Frame raiz: rótulo (escala inversa ao zoom) + nó posicionado no canvas. */
export function FrameView({ frame, zoom }: { frame: Node; zoom: number }) {
  if (frame.hidden) return null;
  const x = frame.position?.x ?? 0;
  const y = frame.position?.y ?? 0;

  return (
    <>
      <div
        className="frame-label"
        style={{ left: x, top: y - 4 / zoom, transform: `translateY(-100%) scale(${1 / zoom})` }}
      >
        {frame.name}
      </div>
      <NodeView
        node={frame}
        extraStyle={{
          position: 'absolute',
          left: x,
          top: y,
          overflow: 'hidden',
          boxShadow: '0 2px 16px rgba(0,0,0,.35)',
        }}
      />
    </>
  );
}
