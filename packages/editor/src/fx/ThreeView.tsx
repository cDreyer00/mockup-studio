import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { MediaParamValue } from '@mockup/core';
import { fxNow, useFxClock } from './clock';
import { fxBegin } from './ready';
import { threeSrcdoc } from './threeIsland';
import type { ThreeToChild, ThreeToParent } from './threeIsland';
import { FX_INNER, fxRootStyle } from './types';
import type { FxViewProps } from './types';

export interface ThreeViewProps {
  /** User function body (see `DEFAULT_THREE_CODE`); runs isolated in an island with an opaque origin. */
  code: string;
  params?: Record<string, MediaParamValue>;
  /** Container style (the iframe fills 100%×100%). */
  style?: CSSProperties;
  /** Pointer events of the content: off by default so it does not steal clicks (use `true` in preview). */
  interactive?: boolean;
  /** Notified with the code's error message (or `null` when it goes away). */
  onError?: (message: string | null) => void;
}

const DRAW_TIMEOUT_MS = 8000;

function ThreeFrame({ code, params, interactive, onError }: ThreeViewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiters = useRef<Array<() => void>>([]);
  const inited = useRef(false);
  const manual = useFxClock((s) => s.manual);
  const playing = useFxClock((s) => s.playing);
  const paramsKey = JSON.stringify(params ?? {});
  const srcdoc = useMemo(() => threeSrcdoc(code, location.origin), [code]);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const send = (msg: ThreeToChild): void => {
    frameRef.current?.contentWindow?.postMessage(msg, '*');
  };
  const sizeOf = (): { w: number; h: number; dpr: number } => {
    const el = frameRef.current;
    return {
      w: el?.offsetWidth || 1,
      h: el?.offsetHeight || 1,
      dpr: Math.min(2, globalThis.devicePixelRatio || 1),
    };
  };
  const wait = (): void => {
    const done = fxBegin(DRAW_TIMEOUT_MS);
    waiters.current.push(done);
  };
  const flush = (): void => {
    const list = waiters.current;
    waiters.current = [];
    for (const done of list) done();
  };

  // Messages from the island (only from the iframe's own window).
  useEffect(() => {
    const onMessage = (ev: MessageEvent): void => {
      if (ev.source !== frameRef.current?.contentWindow) return;
      const m = ev.data as ThreeToParent | null;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') setReady(true);
      else if (m.type === 'drawn') {
        setError(null);
        onErrorRef.current?.(null);
        flush();
      } else if (m.type === 'error') {
        setError(String(m.message).slice(0, 500));
        onErrorRef.current?.(String(m.message).slice(0, 500));
        flush();
      }
    };
    window.addEventListener('message', onMessage);
    if (useFxClock.getState().manual !== null) wait(); // render page: ready on the first frame
    return () => {
      window.removeEventListener('message', onMessage);
      flush();
    };
  }, []);

  // (Re)starts the island when it becomes ready or the parameters change.
  useEffect(() => {
    if (!ready) return;
    const { w, h, dpr } = sizeOf();
    inited.current = true;
    send({
      type: 'init',
      params: params ?? {},
      w,
      h,
      dpr,
      t: fxNow(),
      playing: manual === null && playing,
    });
  }, [ready, paramsKey]);

  // Clock: manual time (frame by frame) or play/pause.
  useEffect(() => {
    if (!ready || !inited.current) return;
    if (manual !== null) {
      wait();
      send({ type: 'time', t: manual });
    } else send({ type: 'play', playing, t: fxNow() });
  }, [ready, manual, playing]);

  // Layout size (without the canvas zoom).
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !ready || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (inited.current) send({ type: 'resize', ...sizeOf() });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  return (
    <>
      <iframe
        ref={frameRef}
        title="Three.js"
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        style={{ ...FX_INNER, pointerEvents: interactive ? 'auto' : 'none' }}
      />
      {error && (
        <div
          data-fx-error
          style={{
            position: 'absolute',
            inset: 'auto 4px 4px 4px',
            padding: '3px 6px',
            font: '11px/14px ui-monospace, monospace',
            color: '#ffd9d9',
            background: 'rgba(120,10,10,.85)',
            borderRadius: 3,
            whiteSpace: 'pre-wrap',
            overflow: 'hidden',
            maxHeight: '60%',
            pointerEvents: 'none',
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}

/** Isolated Three.js island (also usable as a preview with arbitrary `code`). */
export function ThreeView({ code, params, style, interactive, onError }: ThreeViewProps) {
  return (
    <div
      style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%', ...style }}
    >
      {/* `key`: different code = different document, with a new handshake. */}
      <ThreeFrame
        key={code}
        code={code}
        params={params}
        interactive={interactive}
        onError={onError}
      />
    </div>
  );
}

/** `embed` node with the `three` provider on the canvas. */
export function ThreeNodeView({ node, style }: FxViewProps) {
  return (
    <div
      data-node-id={node.id}
      style={{ ...fxRootStyle(style), position: style.position ?? 'relative' }}
    >
      <ThreeFrame
        code={node.embed?.code ?? ''}
        params={node.embed?.params}
        key={node.embed?.code}
      />
    </div>
  );
}
