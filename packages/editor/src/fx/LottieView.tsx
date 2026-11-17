import { useEffect, useRef, useState } from 'react';
import type { AnimationItem } from 'lottie-web';
import { resolveSrc } from '../canvas/render-utils';
import { useFxClock } from './clock';
import { fxBegin } from './ready';
import { FX_INNER, fxRootStyle } from './types';
import type { FxViewProps } from './types';

/** Embed `lottie` (lottie-web light, renderer SVG; carregado sob demanda). */
export function LottieView({ node, style, docId }: FxViewProps) {
  const e = node.embed;
  const src = e?.src ? resolveSrc(docId, e.src) : '';
  const loop = e?.params?.loop !== false;
  const hostRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<AnimationItem | null>(null);
  const loadDone = useRef<(() => void) | null>(null);
  const [loaded, setLoaded] = useState(false);
  const manual = useFxClock((s) => s.manual);
  const playing = useFxClock((s) => s.playing);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !src) return;
    let cancelled = false;
    let anim: AnimationItem | null = null;
    const done = useFxClock.getState().manual !== null ? fxBegin() : null;
    loadDone.current = done;
    setLoaded(false);
    import('lottie-web/build/player/lottie_light')
      .then((m) => {
        if (cancelled) return;
        anim = m.default.loadAnimation({
          container: host,
          renderer: 'svg',
          loop,
          autoplay: false,
          path: src,
        });
        animRef.current = anim;
        anim.addEventListener('DOMLoaded', () => {
          if (!cancelled) setLoaded(true);
        });
        anim.addEventListener('data_failed', () => done?.());
      })
      .catch(() => done?.());
    return () => {
      cancelled = true;
      anim?.destroy();
      animRef.current = null;
      loadDone.current = null;
      done?.();
      setLoaded(false);
    };
  }, [src, loop]);

  useEffect(() => {
    const anim = animRef.current;
    if (!loaded || !anim) return;
    if (manual !== null) {
      const done = fxBegin();
      const dur = anim.getDuration() * 1000;
      const ms = dur > 0 ? (loop ? (manual * 1000) % dur : Math.min(manual * 1000, dur)) : 0;
      anim.goToAndStop(ms, false);
      loadDone.current?.();
      requestAnimationFrame(() => done());
      return;
    }
    if (playing) anim.play();
    else anim.pause();
  }, [loaded, manual, playing, loop]);

  return (
    <div data-node-id={node.id} style={fxRootStyle(style)}>
      <div ref={hostRef} style={FX_INNER} />
    </div>
  );
}
