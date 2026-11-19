/** The presentation's full-screen requests per window (pure logic, no Electron import). */

export interface FullScreenPlan {
  /** Full-screen state the window must be in. */
  target: boolean;
  /** What to remember for the window afterwards (`undefined` = clear). */
  remember: boolean | undefined;
}

/**
 * @param wasFullScreen what was remembered when the presentation started (`undefined` = not presenting)
 * @param on            whether the editor asks to enter (true) or leave (false) the presentation full screen
 * @param isFullScreen  the window's current state
 */
export function planFullScreen(
  wasFullScreen: boolean | undefined,
  on: boolean,
  isFullScreen: boolean,
): FullScreenPlan {
  if (on) return { target: true, remember: wasFullScreen ?? isFullScreen };
  // Leaving: only exit full screen if the window was not full screen before the presentation.
  return {
    target: wasFullScreen === undefined ? isFullScreen : wasFullScreen,
    remember: undefined,
  };
}

/** Runs tasks one after the other per key (a task starts once the previous one for that key settled). */
export class KeyedQueue<K extends object> {
  private readonly tails = new WeakMap<K, Promise<unknown>>();

  run<T>(key: K, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    // The tail never rejects, so one failed task does not break the chain.
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

/** The parts of an Electron `BrowserWindow` the controller uses. */
export interface FullScreenWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  once(event: 'enter-full-screen', listener: () => void): unknown;
  once(event: 'leave-full-screen', listener: () => void): unknown;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'enter-full-screen', listener: () => void): unknown;
  removeListener(event: 'leave-full-screen', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
}

/** Bound on waiting for a full-screen transition (`setFullScreen` is asynchronous on some platforms). */
export const FULL_SCREEN_TRANSITION_MS = 1000;

/**
 * Enters/leaves the presentation full screen of each window. Requests from one window run one at a
 * time (a quick stop + start must not read `isFullScreen()` mid-transition), and the window's
 * `leave-full-screen` caused by a request is not reported to the editor as the user leaving.
 */
export class PresentationFullScreen<W extends FullScreenWindow> {
  /** Was the window already full screen when the presentation started? (absent = not presenting) */
  private readonly remembered = new WeakMap<W, boolean>();
  /** The window is leaving full screen because the editor asked (not the user). */
  private readonly leavingByRequest = new WeakSet<W>();
  private readonly queue = new KeyedQueue<W>();

  constructor(private readonly transitionMs = FULL_SCREEN_TRANSITION_MS) {}

  /** Resolves with whether the window is full screen afterwards. */
  request(win: W, on: boolean): Promise<boolean> {
    return this.queue.run(win, () => this.apply(win, on));
  }

  /**
   * Call from the window's `leave-full-screen` event (registered before any request runs): `true` =
   * tell the editor (the user left full screen), `false` = the app asked for it.
   */
  shouldReportLeave(win: W): boolean {
    if (!this.leavingByRequest.has(win)) return true;
    this.leavingByRequest.delete(win);
    return false;
  }

  forget(win: W): void {
    this.remembered.delete(win);
    this.leavingByRequest.delete(win);
  }

  private async apply(win: W, on: boolean): Promise<boolean> {
    if (win.isDestroyed()) return false;
    const plan = planFullScreen(this.remembered.get(win), on, win.isFullScreen());
    if (plan.remember === undefined) this.remembered.delete(win);
    else this.remembered.set(win, plan.remember);
    if (win.isFullScreen() !== plan.target) {
      if (!plan.target) this.leavingByRequest.add(win);
      await this.transition(win, plan.target);
      // Cleared by the event; also when it never came (timeout, closed), so a later user exit is reported.
      this.leavingByRequest.delete(win);
    }
    return !win.isDestroyed() && win.isFullScreen();
  }

  private transition(win: W, target: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        win.removeListener('enter-full-screen', done);
        win.removeListener('leave-full-screen', done);
        win.removeListener('closed', done);
        resolve();
      };
      const timer = setTimeout(done, this.transitionMs);
      if (target) win.once('enter-full-screen', done);
      else win.once('leave-full-screen', done);
      win.once('closed', done);
      win.setFullScreen(target);
    });
  }
}
