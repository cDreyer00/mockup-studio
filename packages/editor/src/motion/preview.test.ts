// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@mockup/core';
import { canvasMotion, motionPreview, useMotionPreview } from './preview';

let now = 1000;

const animation = (duration: number) => ({ kind: 'in' as const, preset: 'fade', duration });
const frameWith = (duration: number): { frame: Node; child: Node } => {
  const child: Node = {
    id: 'el_box',
    type: 'element',
    name: 'Box',
    tag: 'div',
    attrs: {},
    style: {},
    children: [],
    locked: false,
    hidden: false,
    animations: [animation(duration)],
  };
  const frame: Node = { ...child, id: 'fr_prev', type: 'frame', children: [child] };
  delete frame.animations;
  return { frame, child };
};

/** Advances the document timeline and the timers together, in small steps. */
function tick(ms: number): void {
  for (let left = ms; left > 0; left -= 10) {
    const step = Math.min(10, left);
    now += step;
    vi.advanceTimersByTime(step);
  }
}

describe('motionPreview', () => {
  const frameEl = document.createElement('div');
  const childEl = document.createElement('div');
  frameEl.appendChild(childEl);

  /** Registers the frame like the canvas does on every document change. */
  const show = (duration: number): void => {
    const { frame, child } = frameWith(duration);
    canvasMotion.attach(frame.id, child, childEl);
    canvasMotion.setFrame(frame.id, frame, frameEl);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = () => ({
      currentTime: 0,
      startTime: null,
      pause() {},
      play() {},
      cancel() {},
      persist() {},
    });
    Object.defineProperty(document, 'timeline', {
      configurable: true,
      value: {
        get currentTime() {
          return now;
        },
      },
    });
  });

  afterEach(() => {
    motionPreview.stop();
    vi.useRealTimers();
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });

  it('a play does not end early when an edit makes the timeline longer', () => {
    show(600);
    motionPreview.play('fr_prev');
    expect(useMotionPreview.getState()).toMatchObject({ mode: 'play', duration: 600 });
    tick(400);
    show(1200);
    expect(useMotionPreview.getState().duration).toBe(1200);
    tick(400); // past the old end
    expect(useMotionPreview.getState()).toMatchObject({ mode: 'play', ended: false });
    tick(500); // past the new end
    expect(useMotionPreview.getState()).toMatchObject({ mode: 'seek', time: 1200, ended: true });
  });

  it('a play ends at once when an edit makes the timeline shorter than the playhead', () => {
    show(1200);
    motionPreview.play('fr_prev');
    tick(500);
    show(300);
    tick(50);
    expect(useMotionPreview.getState()).toMatchObject({ mode: 'seek', time: 300, ended: true });
  });

  it('a paused preview takes the new duration and keeps its time', () => {
    show(600);
    motionPreview.seek('fr_prev', 500);
    show(400);
    expect(useMotionPreview.getState()).toMatchObject({
      mode: 'seek',
      time: 400,
      duration: 400,
      ended: true,
    });
    show(900);
    expect(useMotionPreview.getState()).toMatchObject({ time: 400, duration: 900, ended: false });
  });
});
