/**
 * Motion preview on the canvas: the timeline's play / scrub / stop (and the MCP `preview_motion`).
 * One frame at a time is previewed; every other frame stays in the design state. The store only
 * changes when the mode changes: the playhead while playing comes from `motionPreview.playhead()`
 * (read it in a requestAnimationFrame loop, not through React state).
 */
import { create } from 'zustand';
import type { MotionPreviewState } from '@mockup/core';
import { MotionScope } from './scope';

let viewport: Element | null = null;

/** Motion scope of the editor canvas: loops play in the design state and pause off screen. */
export const canvasMotion = new MotionScope({ loopsInRest: true, viewport: () => viewport });

/** The canvas viewport (scroll container) mounted or changed. */
export function setCanvasViewport(el: Element | null): void {
  if (viewport === el) return;
  viewport = el;
  canvasMotion.refreshViewport();
}

export interface MotionPreviewStore {
  frameId: string | null;
  mode: 'rest' | 'seek' | 'play';
  /** Playhead when the mode changed (ms on the frame's linear timeline). */
  time: number;
  /** Linear duration of the previewed frame when the mode changed (ms). */
  duration: number;
  /** Playback reached the end (loops keep running in `play`). */
  ended: boolean;
}

const IDLE: MotionPreviewStore = {
  frameId: null,
  mode: 'rest',
  time: 0,
  duration: 0,
  ended: false,
};

export const useMotionPreview = create<MotionPreviewStore>(() => IDLE);

let endTimer: ReturnType<typeof setTimeout> | undefined;

const durationOf = (frameId: string): number => canvasMotion.timeline(frameId)?.duration ?? 0;

function leaveOther(frameId: string): void {
  const prev = useMotionPreview.getState().frameId;
  if (prev && prev !== frameId) canvasMotion.setMode(prev, { type: 'rest' });
}

function onEnd(): void {
  const s = useMotionPreview.getState();
  if (s.mode !== 'play' || !s.frameId) return;
  const duration = durationOf(s.frameId);
  if (canvasMotion.timeline(s.frameId)?.loops) {
    useMotionPreview.setState({ ended: true, time: duration, duration });
    return;
  }
  canvasMotion.setMode(s.frameId, { type: 'seek', at: { time: duration } });
  useMotionPreview.setState({ mode: 'seek', time: duration, duration, ended: true });
}

export const motionPreview = {
  /** Plays the frame's linear timeline from `from` ms (from the start when already at the end). */
  play(frameId: string, from = 0): void {
    leaveOther(frameId);
    const duration = durationOf(frameId);
    const start = from >= duration ? 0 : Math.max(0, from);
    canvasMotion.setMode(frameId, { type: 'play', from: start });
    useMotionPreview.setState({ frameId, mode: 'play', time: start, duration, ended: false });
    clearTimeout(endTimer);
    endTimer = setTimeout(onEnd, Math.max(0, duration - start) + 30);
  },

  /** Pauses the frame at `time` ms of its linear timeline. */
  seek(frameId: string, time: number): void {
    leaveOther(frameId);
    clearTimeout(endTimer);
    const duration = durationOf(frameId);
    const t = Math.min(Math.max(0, time), Math.max(duration, 0));
    canvasMotion.setMode(frameId, { type: 'seek', at: { time: t } });
    useMotionPreview.setState({ frameId, mode: 'seek', time: t, duration, ended: t >= duration });
  },

  /** Pauses where the playhead is. */
  pause(): void {
    const s = useMotionPreview.getState();
    if (s.mode !== 'play' || !s.frameId) return;
    motionPreview.seek(s.frameId, motionPreview.playhead());
  },

  /** Back to the design state. */
  stop(): void {
    clearTimeout(endTimer);
    const s = useMotionPreview.getState();
    if (s.frameId) canvasMotion.setMode(s.frameId, { type: 'rest' });
    useMotionPreview.setState(IDLE);
  },

  /** Live playhead (ms), without React. */
  playhead(): number {
    const s = useMotionPreview.getState();
    if (!s.frameId) return 0;
    if (s.mode === 'play')
      return Math.min(canvasMotion.linearTime(s.frameId), durationOf(s.frameId));
    return s.time;
  },

  getState(): MotionPreviewState {
    const s = useMotionPreview.getState();
    return {
      frameId: s.frameId,
      mode: s.mode,
      time: Math.round(motionPreview.playhead()),
      duration: s.frameId ? durationOf(s.frameId) : 0,
    };
  },
};
