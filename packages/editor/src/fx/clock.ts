/**
 * Clock for the canvas animations (effects, particles, video, Lottie, Rive, Three.js).
 *
 * - Editor: real time while `playing`; pausing freezes time (play resumes where it left off).
 * - Render page: manual time (`setManual(t)`), for screenshots and deterministic frames.
 */
import { create } from 'zustand';

export interface FxClockState {
  /** Animations playing in the editor (the bar's play/pause button). */
  playing: boolean;
  /** Manual time in seconds (render page) or `null` (real time). */
  manual: number | null;
}

export const useFxClock = create<FxClockState>(() => ({ playing: true, manual: null }));

let base = 0; // time accumulated up to the last play/pause (s)
let since = typeof performance !== 'undefined' ? performance.now() : 0;

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Current animation time in seconds. */
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
  /** Fixes the time (s) or goes back to real time with `null`. */
  setManual(t: number | null): void {
    useFxClock.setState({ manual: t });
  },
};
