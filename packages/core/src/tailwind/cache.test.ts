import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTailwindEngines, getTailwindEngine, peekTailwindEngine } from './cache.js';

const doc = { tokens: {}, themes: [] };

describe('Tailwind engine cache: idle warm-up', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearTailwindEngines();
  });

  it('schedules warmup() after creating the engine, once, without blocking the promise', async () => {
    clearTailwindEngines();
    const engine = await getTailwindEngine(doc, { warmup: false });
    clearTailwindEngines();
    const spy = vi.spyOn(Object.getPrototypeOf(engine) as { warmup(): void }, 'warmup');
    const fresh = await getTailwindEngine(doc);
    expect(spy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
    await getTailwindEngine(doc);
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(peekTailwindEngine(doc)).toBe(fresh);
    spy.mockRestore();
  });

  it('warmup: false does not schedule', async () => {
    clearTailwindEngines();
    const probe = await getTailwindEngine(doc, { warmup: false });
    clearTailwindEngines();
    const spy = vi.spyOn(Object.getPrototypeOf(probe) as { warmup(): void }, 'warmup');
    await getTailwindEngine(doc, { warmup: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
