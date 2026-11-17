/**
 * Helper components that the React export embeds in the `.tsx` when there are media nodes: animated
 * effect (Mockup Studio runtime), Lottie (`lottie-web`), Rive (`@rive-app/canvas`) and a
 * Three.js island (`<slug>-three-<n>.js` file generated alongside).
 */

export type ReactMediaHelper = 'effect' | 'lottie' | 'rive' | 'three';

export const REACT_MEDIA_ORDER: readonly ReactMediaHelper[] = ['effect', 'lottie', 'rive', 'three'];

/** Imports of each helper (besides React's `useEffect`, `useRef` and `CSSProperties`). */
export const REACT_MEDIA_IMPORTS: Record<ReactMediaHelper, string | null> = {
  effect: "import { playEffect, type EffectMount } from './mockup-effects.js';",
  lottie: "import lottie from 'lottie-web';",
  rive: "import { Rive } from '@rive-app/canvas';",
  three: null,
};

/** Types shared by the helpers. */
export const REACT_MEDIA_TYPES: Record<ReactMediaHelper, string | null> = {
  effect: null,
  lottie: null,
  rive: null,
  three: 'type ThreeParams = Record<string, string | number | boolean>;',
};

export const REACT_MEDIA_BOX = 'type Box = { className?: string; style?: CSSProperties };';

/** Names the helpers occupy in the file (the component and the constants cannot use them). */
export const REACT_MEDIA_NAMES = [
  'Box',
  'EffectMount',
  'ThreeParams',
  'MockupEffect',
  'MockupLottie',
  'MockupRive',
  'ThreeIsland',
  'playEffect',
  'lottie',
  'Rive',
  'useEffect',
  'useRef',
];

export const REACT_MEDIA_HELPERS: Record<ReactMediaHelper, string> = {
  effect: `/** Animated effect (WebGL/canvas 2D) from Mockup Studio. */
function MockupEffect({ spec, className, style }: { spec: EffectMount } & Box) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const player = playEffect(ref.current, spec);
    return () => player.stop();
  }, [spec]);
  return <canvas ref={ref} aria-hidden="true" className={className} style={style} />;
}`,
  lottie: `/** Lottie animation (lottie-web). */
function MockupLottie({
  src,
  loop = true,
  autoplay = true,
  className,
  style,
}: { src: string; loop?: boolean; autoplay?: boolean } & Box) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const anim = lottie.loadAnimation({
      container: ref.current,
      path: src,
      loop,
      autoplay,
      renderer: 'svg',
    });
    return () => anim.destroy();
  }, [src, loop, autoplay]);
  return <div ref={ref} className={className} style={style} />;
}`,
  rive: `/** Rive animation (@rive-app/canvas). */
function MockupRive({
  src,
  autoplay = true,
  artboard,
  stateMachine,
  className,
  style,
}: { src: string; autoplay?: boolean; artboard?: string; stateMachine?: string } & Box) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const r = new Rive({
      src,
      canvas: ref.current,
      autoplay,
      ...(artboard ? { artboard } : {}),
      ...(stateMachine ? { stateMachines: stateMachine } : {}),
      onLoad: () => r.resizeDrawingSurfaceToCanvas(),
    });
    return () => r.cleanup();
  }, [src, autoplay, artboard, stateMachine]);
  return <canvas ref={ref} className={className} style={style} />;
}`,
  three: `/** Three.js island: \`setup\` builds the scene on the canvas and returns the function that tears it down. */
function ThreeIsland({
  setup,
  params,
  className,
  style,
}: {
  setup: (canvas: HTMLCanvasElement, params: ThreeParams) => () => void;
  params: ThreeParams;
} & Box) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return setup(ref.current, params);
  }, [setup, params]);
  return <canvas ref={ref} className={className} style={style} />;
}`,
};
