/**
 * Relógio das animações do canvas (efeitos, partículas, vídeo, Lottie, Rive, Three.js).
 *
 * - Editor: tempo real enquanto `playing`; pausar congela o tempo (play continua de onde parou).
 * - Página de render: tempo manual (`setManual(t)`), para screenshots e quadros determinísticos.
 */
import { create } from 'zustand';

export interface FxClockState {
  /** Animações tocando no editor (botão play/pausa da barra). */
  playing: boolean;
  /** Tempo manual em segundos (página de render) ou `null` (tempo real). */
  manual: number | null;
}

export const useFxClock = create<FxClockState>(() => ({ playing: true, manual: null }));

let base = 0; // tempo acumulado até o último play/pausa (s)
let since = typeof performance !== 'undefined' ? performance.now() : 0;

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Tempo atual das animações em segundos. */
export function fxNow(): number {
  const s = useFxClock.getState();
  if (s.manual !== null) return s.manual;
  return s.playing ? base + (nowMs() - since) / 1000 : base;
}

export const fxClock = {
  setPlaying(playing: boolean): void {
    const s = useFxClock.getState();
    if (s.playing === playing) return;
    base = fxNow();
    since = nowMs();
    useFxClock.setState({ playing });
  },
  toggle(): void {
    fxClock.setPlaying(!useFxClock.getState().playing);
  },
  /** Fixa o tempo (s) ou volta ao tempo real com `null`. */
  setManual(t: number | null): void {
    useFxClock.setState({ manual: t });
  },
};
