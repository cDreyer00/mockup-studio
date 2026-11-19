import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { KeyedQueue, PresentationFullScreen } from './main/fullscreen.js';

/** A window whose full-screen transitions finish asynchronously, like on some platforms. */
class FakeWindow extends EventEmitter {
  fullScreen = false;
  calls: boolean[] = [];
  /** Leave/enter events reported to the editor (what main forwards to the renderer). */
  reported = 0;

  constructor(
    ctrl: PresentationFullScreen<FakeWindow>,
    private readonly delayMs: number | null = 5,
  ) {
    super();
    // Same order as main: the forwarder is registered when the window is created.
    this.on('leave-full-screen', () => {
      if (ctrl.shouldReportLeave(this)) this.reported++;
    });
  }

  isDestroyed(): boolean {
    return false;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  setFullScreen(on: boolean): void {
    this.calls.push(on);
    if (this.delayMs === null) return; // never finishes
    setTimeout(() => this.finish(on), this.delayMs);
  }
  finish(on: boolean): void {
    if (this.fullScreen === on) return;
    this.fullScreen = on;
    this.emit(on ? 'enter-full-screen' : 'leave-full-screen');
  }
}

describe('KeyedQueue', () => {
  it('runs the tasks of one key in order and keys independently', async () => {
    const q = new KeyedQueue<object>();
    const a = {};
    const b = {};
    const log: string[] = [];
    const task = (name: string, ms: number) => () =>
      new Promise<string>((resolve) =>
        setTimeout(() => {
          log.push(name);
          resolve(name);
        }, ms),
      );
    const results = await Promise.all([
      q.run(a, task('a1', 20)),
      q.run(a, task('a2', 1)),
      q.run(b, task('b1', 5)),
    ]);
    expect(results).toEqual(['a1', 'a2', 'b1']);
    expect(log).toEqual(['b1', 'a1', 'a2']);
  });

  it('keeps going after a failed task', async () => {
    const q = new KeyedQueue<object>();
    const k = {};
    const failed = q.run(k, () => Promise.reject(new Error('boom')));
    const next = q.run(k, async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});

describe('PresentationFullScreen', () => {
  it('enters and leaves, and its own exit is not reported as the user leaving', async () => {
    const ctrl = new PresentationFullScreen<FakeWindow>();
    const win = new FakeWindow(ctrl);
    await expect(ctrl.request(win, true)).resolves.toBe(true);
    await expect(ctrl.request(win, false)).resolves.toBe(false);
    expect(win.calls).toEqual([true, false]);
    expect(win.reported).toBe(0);
  });

  it('a quick leave + enter (restart) is serialized and ends in full screen', async () => {
    const ctrl = new PresentationFullScreen<FakeWindow>();
    const win = new FakeWindow(ctrl);
    await ctrl.request(win, true);
    // Both arrive before the first transition finished.
    const [left, entered] = await Promise.all([ctrl.request(win, false), ctrl.request(win, true)]);
    expect(left).toBe(false);
    expect(entered).toBe(true);
    expect(win.calls).toEqual([true, false, true]);
    expect(win.isFullScreen()).toBe(true);
    // The leave in the middle came from the app: the new presentation is not ended.
    expect(win.reported).toBe(0);
  });

  it('reports the user leaving full screen', async () => {
    const ctrl = new PresentationFullScreen<FakeWindow>();
    const win = new FakeWindow(ctrl);
    await ctrl.request(win, true);
    win.finish(false); // Esc / F11 outside the app's requests
    expect(win.reported).toBe(1);
  });

  it('leaves full screen only if the window was not full screen before', async () => {
    const ctrl = new PresentationFullScreen<FakeWindow>();
    const win = new FakeWindow(ctrl);
    win.fullScreen = true;
    await expect(ctrl.request(win, true)).resolves.toBe(true);
    await expect(ctrl.request(win, false)).resolves.toBe(true);
    expect(win.calls).toEqual([]);
  });

  it('clears the request flag when the transition never finishes', async () => {
    const ctrl = new PresentationFullScreen<FakeWindow>(10);
    const win = new FakeWindow(ctrl, null);
    await expect(ctrl.request(win, true)).resolves.toBe(false); // times out
    win.fullScreen = true; // got there late, without the event
    await expect(ctrl.request(win, false)).resolves.toBe(true); // times out too
    // The flag did not stay set: a later exit by the user is reported.
    win.finish(false);
    expect(win.reported).toBe(1);
  });
});
