import type { Document } from '../types.js';
import { createTailwindEngine, tailwindEngineKey, type TailwindEngine } from './engine.js';

/**
 * Engine cache keyed by tokens (`tailwindEngineKey`): the same document reuses the
 * compiler until the `@theme` tokens change (then the key changes and a new engine is created).
 * Keeps the last 8 engines and dedupes concurrent creations.
 */
const MAX = 8;
const ready = new Map<string, TailwindEngine>();
const pending = new Map<string, Promise<TailwindEngine>>();

function remember(key: string, engine: TailwindEngine): void {
  ready.delete(key);
  ready.set(key, engine);
  while (ready.size > MAX) ready.delete(ready.keys().next().value!);
}

const warmed = new WeakSet<TailwindEngine>();

/**
 * Warms the engine up when idle (once per engine), without blocking the caller: `requestIdleCallback` in
 * the browser, `setTimeout(0)` in Node (after the response is out). This way the first `get_code` or
 * "Show as Tailwind" does not pay for building the canonicalization indexes.
 */
function scheduleWarmup(engine: TailwindEngine): void {
  if (warmed.has(engine)) return;
  warmed.add(engine);
  const run = (): void => {
    try {
      engine.warmup();
    } catch {
      /* warm-up is only an optimization */
    }
  };
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => unknown })
    .requestIdleCallback;
  if (typeof ric === 'function') ric.call(globalThis, run);
  else setTimeout(run, 0);
}

/**
 * Document engine (created on the first call; afterwards it comes from the cache). `warmup: false` does not schedule
 * the idle warm-up of the newly created engine.
 */
export function getTailwindEngine(
  doc: Pick<Document, 'tokens' | 'themes'>,
  options: { warmup?: boolean } = {},
): Promise<TailwindEngine> {
  const key = tailwindEngineKey(doc);
  const hit = ready.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  let p = pending.get(key);
  if (!p) {
    p = createTailwindEngine(doc)
      .then((engine) => {
        remember(key, engine);
        if (options.warmup !== false) scheduleWarmup(engine);
        return engine;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/** Engine already ready for the document, without waiting (`undefined` if not created yet). */
export function peekTailwindEngine(
  doc: Pick<Document, 'tokens' | 'themes'>,
): TailwindEngine | undefined {
  return ready.get(tailwindEngineKey(doc));
}

/** Clears the cache (tests). */
export function clearTailwindEngines(): void {
  ready.clear();
  pending.clear();
}
