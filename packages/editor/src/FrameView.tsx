import type { Node } from '@mockup/core';
import { ErrorBoundary } from './ErrorBoundary';
import { NodeView } from './NodeView';

/** Frame raiz: rótulo (escala inversa ao zoom) + nó posicionado no canvas. */
export function FrameView({ frame, zoom }: { frame: Node; zoom: number }) {
  if (frame.hidden) return null;
  const x = frame.position?.x ?? 0;
  const y = frame.position?.y ?? 0;
  const w = parseFloat(frame.style?.width ?? '');
  const h = parseFloat(frame.style?.height ?? '');

  return (
    <>
      <div
        className="frame-label"
        style={{ left: x, top: y - 4 / zoom, transform: `translateY(-100%) scale(${1 / zoom})` }}
      >
        {frame.name}
      </div>
      <ErrorBoundary
        fallback={(error) => (
          <div
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: Number.isFinite(w) ? w : 800,
              height: Number.isFinite(h) ? h : 600,
              background: '#2a1d1d',
              border: '1px solid #c33',
              color: '#f3c0c0',
              padding: 16,
              boxSizing: 'border-box',
              overflow: 'hidden',
            }}
          >
            Falha ao renderizar este frame: {error.message}
          </div>
        )}
      >
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
      </ErrorBoundary>
    </>
  );
}
