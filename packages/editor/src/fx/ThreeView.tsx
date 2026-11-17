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
  /** Corpo de função do usuário (ver `DEFAULT_THREE_CODE`); roda isolado numa ilha com origem opaca. */
  code: string;
  params?: Record<string, MediaParamValue>;
  /** Estilo do contêiner (o iframe preenche 100%×100%). */
  style?: CSSProperties;
  /** Pointer events do conteúdo: desligado por padrão para não roubar cliques (use `true` em preview). */
  interactive?: boolean;
  /** Notificado com a mensagem de erro do código (ou `null` quando some). */
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

  // Mensagens da ilha (só da janela do próprio iframe).
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
    if (useFxClock.getState().manual !== null) wait(); // página de render: pronto no primeiro quadro
    return () => {
      window.removeEventListener('message', onMessage);
      flush();
    };
  }, []);

  // (Re)inicia a ilha quando fica pronta ou os parâmetros mudam.
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

  // Relógio: tempo manual (quadro por quadro) ou play/pausa.
  useEffect(() => {
    if (!ready || !inited.current) return;
    if (manual !== null) {
      wait();
      send({ type: 'time', t: manual });
    } else send({ type: 'play', playing, t: fxNow() });
  }, [ready, manual, playing]);

  // Tamanho do layout (sem o zoom do canvas).
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

/** Ilha Three.js isolada (também usável como preview com `code` arbitrário). */
export function ThreeView({ code, params, style, interactive, onError }: ThreeViewProps) {
  return (
    <div
      style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%', ...style }}
    >
      {/* `key`: outro código = outro documento, com handshake novo. */}
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

/** Nó `embed` com provedor `three` no canvas. */
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
