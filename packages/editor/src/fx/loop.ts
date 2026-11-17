/**
 * Shared RAF loop: while the clock is playing and without manual time, calls each
 * subscriber with the current time. Stops on its own (no subscribers, paused or in manual time).
 */
import { fxNow, useFxClock } from './clock';

type FrameCb = (t: number) => void;

const subs = new Set<FrameCb>();
let raf = 0;

function tick(): void {
  raf = 0;
  const s = useFxClock.getState();
  if (subs.size === 0 || !s.playing || s.manual !== null) return;
  const t = fxNow();
  for (const cb of subs) cb(t);
  raf = requestAnimationFrame(tick);
}

function kick(): void {
  if (raf || subs.size === 0 || typeof requestAnimationFrame === 'undefined') return;
  raf = requestAnimationFrame(tick);
}

useFxClock.subscribe(kick);

/** Subscribes to the loop; returns the unsubscribe function. */
export function fxSubscribe(cb: FrameCb): () => void {
  subs.add(cb);
  kick();
  return () => {
    subs.delete(cb);
  };
}
