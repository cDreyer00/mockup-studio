/**
 * Animation readiness registry: each media component registers a pending item when
 * it starts loading or when the manual time changes, and releases it after drawing that time.
 * The render page waits for `fxSettled()` before measuring/capturing.
 */

const pending = new Set<Promise<void>>();

/** Information about the current render (filled in by the render page before mounting the frame). */
export const fxRenderInfo = {
  /** The caller passed `time` explicitly (video with a poster only uses the poster if it did NOT). */
  explicitTime: false,
};

/**
 * Registers a pending item and returns the function that releases it. Releases itself after `maxMs` so that
 * a component that failed to report never hangs the page.
 */
export function fxBegin(maxMs = 15000): () => void {
  let release!: () => void;
  const p = new Promise<void>((r) => {
    release = r;
  });
  pending.add(p);
  const timer = setTimeout(release, maxMs);
  void p.then(() => {
    clearTimeout(timer);
    pending.delete(p);
  });
  return release;
}

/** Number of pending items (tests and diagnostics). */
export function fxPendingCount(): number {
  return pending.size;
}

/** Waits for all pending items (including those registered while waiting), with a limit. */
export async function fxSettled(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let quietTicks = 0;
  for (;;) {
    if (pending.size === 0) {
      // One extra turn: newly mounted effects may register pending items right after.
      if (quietTicks++ >= 1) return true;
      await new Promise((r) => setTimeout(r, 0));
      continue;
    }
    quietTicks = 0;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...pending]),
      new Promise((r) => {
        timer = setTimeout(r, left);
      }),
    ]);
    clearTimeout(timer);
  }
}

/** Waits for one of the events (or the time limit) on an element. */
export function fxOnce(
  el: EventTarget,
  events: string[],
  ms: number,
): Promise<'event' | 'timeout'> {
  return new Promise((resolve) => {
    const off = (): void => {
      clearTimeout(timer);
      for (const e of events) el.removeEventListener(e, onEvent);
    };
    const onEvent = (): void => {
      off();
      resolve('event');
    };
    const timer = setTimeout(() => {
      off();
      resolve('timeout');
    }, ms);
    for (const e of events) el.addEventListener(e, onEvent, { once: true });
  });
}
