import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { effectFallbackCss, effectMountSpec, mockupEffectsRuntime } from '@mockup/core';
import type { EffectHandle, EffectSpec } from '@mockup/core';
import { convertStyle } from '../canvas/render-utils';
import { fxNow, useFxClock } from './clock';
import { fxSubscribe } from './loop';
import { fxBegin } from './ready';
import { FX_INNER, fxRootStyle } from './types';
import type { FxViewProps } from './types';

export interface EffectCanvasProps {
  spec: EffectSpec;
  /** Tamanho fixo em px CSS (miniaturas); sem isso preenche o pai (100%) e acompanha o tamanho. */
  width?: number;
  height?: number;
  /** Tempo fixo (s): desenha só esse quadro e não anima. Sem isso usa o relógio do editor. */
  time?: number;
  style?: CSSProperties;
}

const dprNow = (): number => Math.min(2, globalThis.devicePixelRatio || 1);

/** `<canvas>` de um efeito. Usável fora do canvas do editor (miniaturas/preview). */
export function EffectCanvas({ spec, width, height, time, style }: EffectCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [handle, setHandle] = useState<EffectHandle | null>(null);
  const visible = useRef(true);
  const manual = useFxClock((s) => s.manual);
  const playing = useFxClock((s) => s.playing);
  const staticTime = time ?? manual;
  const fixed = width !== undefined && height !== undefined;

  const mountSpec = useMemo(() => effectMountSpec(spec), [spec]);
  const paramsKey = JSON.stringify(mountSpec.params);
  const specRef = useRef(mountSpec);
  specRef.current = mountSpec;
  const staticTimeRef = useRef<number | null>(staticTime);
  staticTimeRef.current = staticTime;

  // Monta o runtime quando o efeito (kind) muda.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const h = mockupEffectsRuntime().mount(canvas, specRef.current);
    setHandle(h);
    return () => {
      h.destroy();
      setHandle(null);
    };
  }, [mountSpec.kind, mountSpec.category]);

  // Tamanho (layout, sem o transform de zoom) e densidade.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !handle) return;
    const apply = (): void => {
      const w = fixed ? width : canvas.offsetWidth;
      const h = fixed ? height : canvas.offsetHeight;
      if (w > 0 && h > 0) handle.resize(w, h, dprNow());
    };
    apply();
    if (fixed || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      apply();
      handle.draw(staticTimeRef.current ?? fxNow());
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [handle, fixed, width, height]);

  // Visibilidade: não desenha efeitos fora da tela.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) visible.current = e.isIntersecting;
    });
    io.observe(canvas);
    return () => io.disconnect();
  }, []);

  // Parâmetros sem recriar o contexto.
  useEffect(() => {
    handle?.setParams(specRef.current.params);
  }, [handle, paramsKey]);

  // Quadro fixo (tempo manual / `time`) ou pausado: desenha uma vez a cada mudança.
  useEffect(() => {
    if (!handle) return;
    if (staticTime !== null) {
      // Na página de render (tempo manual) avisa que este tempo foi desenhado.
      const done = manual !== null ? fxBegin() : null;
      handle.draw(staticTime);
      done?.();
    } else if (!playing) handle.draw(fxNow());
  }, [handle, staticTime, manual, playing, paramsKey]);

  // Tempo real: laço compartilhado.
  useEffect(() => {
    if (!handle || staticTime !== null || !playing) return;
    return fxSubscribe((t) => {
      if (visible.current) handle.draw(t);
    });
  }, [handle, staticTime, playing]);

  const failed = handle !== null && !handle.ok;
  const canvasStyle: CSSProperties = {
    ...FX_INNER,
    ...(fixed ? { width, height } : null),
    ...(!handle || failed ? convertStyle(effectFallbackCss(spec)) : null),
    ...style,
  };
  return (
    <>
      <canvas
        ref={canvasRef}
        style={canvasStyle}
        data-fx-ok={handle ? String(handle.ok) : 'pending'}
      />
      {failed && (
        <span
          data-fx-error
          title={handle.error}
          style={{
            position: 'absolute',
            right: 4,
            bottom: 4,
            padding: '1px 5px',
            font: '10px/14px system-ui, sans-serif',
            color: '#fff',
            background: 'rgba(0,0,0,.55)',
            borderRadius: 3,
            pointerEvents: 'none',
          }}
        >
          efeito indisponível
        </span>
      )}
    </>
  );
}

/** Nó `effect` no canvas. */
export function EffectView({ node, style }: FxViewProps) {
  const spec = node.effect ?? { kind: '', params: {} };
  return (
    <div
      data-node-id={node.id}
      style={{ ...fxRootStyle(style), position: style.position ?? 'relative' }}
    >
      <EffectCanvas spec={spec} />
    </div>
  );
}
