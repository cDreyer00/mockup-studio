import { useEffect, useRef, useState } from 'react';
import type { Rive } from '@rive-app/canvas';
import { resolveSrc } from '../canvas/render-utils';
import { useFxClock } from './clock';
import { fxBegin } from './ready';
import { FX_INNER, fxRootStyle } from './types';
import type { FxViewProps } from './types';

/** Embed `rive` (@rive-app/canvas, wasm local; carregado sob demanda). */
export function RiveView({ node, style, docId }: FxViewProps) {
  const e = node.embed;
  const src = e?.src ? resolveSrc(docId, e.src) : '';
  const artboard = typeof e?.params?.artboard === 'string' ? e.params.artboard : undefined;
  const stateMachine =
    typeof e?.params?.stateMachine === 'string' ? e.params.stateMachine : undefined;
  const autoplay = e?.params?.autoplay !== false;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const riveRef = useRef<Rive | null>(null);
  const loadDone = useRef<(() => void) | null>(null);
  const [loaded, setLoaded] = useState(false);
  const manual = useFxClock((s) => s.manual);
  const playing = useFxClock((s) => s.playing);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src) return;
    let cancelled = false;
    let instance: Rive | null = null;
    const done = useFxClock.getState().manual !== null ? fxBegin() : null;
    loadDone.current = done;
    setLoaded(false);
    import('./riveRuntime')
      .then(({ default: rive }) => {
        if (cancelled) return;
        instance = new rive.Rive({
          src,
          canvas,
          artboard,
          stateMachines: stateMachine,
          autoplay: false,
          onLoad: () => {
            if (cancelled) return;
            instance?.resizeDrawingSurfaceToCanvas();
            setLoaded(true);
          },
          onLoadError: () => done?.(),
        });
        riveRef.current = instance;
      })
      .catch(() => done?.());
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => riveRef.current?.resizeDrawingSurfaceToCanvas())
        : null;
    ro?.observe(canvas);
    return () => {
      cancelled = true;
      ro?.disconnect();
      instance?.cleanup();
      riveRef.current = null;
      loadDone.current = null;
      done?.();
      setLoaded(false);
    };
  }, [src, artboard, stateMachine]);

  useEffect(() => {
    const r = riveRef.current;
    if (!loaded || !r) return;
    if (manual !== null) {
      // Melhor esforço: pausa e posiciona as animações lineares no tempo (state machines ficam no início).
      const done = fxBegin();
      try {
        r.pause();
        if (!stateMachine) r.scrub(undefined, manual);
      } catch {
        /* sem animação linear: segue com o quadro atual */
      }
      loadDone.current?.();
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
      return;
    }
    if (playing && autoplay) r.play();
    else r.pause();
  }, [loaded, manual, playing, autoplay, stateMachine]);

  return (
    <div data-node-id={node.id} style={fxRootStyle(style)}>
      <canvas ref={canvasRef} style={FX_INNER} />
    </div>
  );
}
