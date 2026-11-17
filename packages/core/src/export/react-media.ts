/**
 * Componentes auxiliares que o export React embute no `.tsx` quando há nós de mídia: efeito
 * animado (runtime do Mockup Studio), Lottie (`lottie-web`), Rive (`@rive-app/canvas`) e ilha
 * Three.js (arquivo `<slug>-three-<n>.js` gerado ao lado).
 */

export type ReactMediaHelper = 'effect' | 'lottie' | 'rive' | 'three';

export const REACT_MEDIA_ORDER: readonly ReactMediaHelper[] = ['effect', 'lottie', 'rive', 'three'];

/** Imports de cada helper (além de `useEffect`, `useRef` e `CSSProperties` do React). */
export const REACT_MEDIA_IMPORTS: Record<ReactMediaHelper, string | null> = {
  effect: "import { playEffect, type EffectMount } from './mockup-effects.js';",
  lottie: "import lottie from 'lottie-web';",
  rive: "import { Rive } from '@rive-app/canvas';",
  three: null,
};

/** Tipos compartilhados pelos helpers. */
export const REACT_MEDIA_TYPES: Record<ReactMediaHelper, string | null> = {
  effect: null,
  lottie: null,
  rive: null,
  three: 'type ThreeParams = Record<string, string | number | boolean>;',
};

export const REACT_MEDIA_BOX = 'type Box = { className?: string; style?: CSSProperties };';

/** Nomes que os helpers ocupam no arquivo (o componente e as constantes não podem usá-los). */
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
  effect: `/** Efeito animado (WebGL/canvas 2D) do Mockup Studio. */
function MockupEffect({ spec, className, style }: { spec: EffectMount } & Box) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const player = playEffect(ref.current, spec);
    return () => player.stop();
  }, [spec]);
  return <canvas ref={ref} aria-hidden="true" className={className} style={style} />;
}`,
  lottie: `/** Animação Lottie (lottie-web). */
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
  rive: `/** Animação Rive (@rive-app/canvas). */
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
  three: `/** Ilha Three.js: \`setup\` monta a cena no canvas e devolve a função que a desmonta. */
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
