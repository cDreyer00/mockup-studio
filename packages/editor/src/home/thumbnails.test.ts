import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedThumbnail, loadThumbnail, resetThumbnails, thumbnailStats } from './thumbnails';

interface Pending {
  url: string;
  signal: AbortSignal;
  resolve: (r: Response) => void;
}

describe('thumbnail loader', () => {
  let pending: Pending[];
  let created = 0;
  beforeEach(() => {
    pending = [];
    created = 0;
    resetThumbnails();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            pending.push({ url, signal: init.signal!, resolve });
            init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    vi.stubGlobal('URL', {
      createObjectURL: () => `blob:thumb-${++created}`,
      revokeObjectURL: () => undefined,
    });
  });
  afterEach(() => {
    resetThumbnails();
    vi.unstubAllGlobals();
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const png = () => new Response(new Blob(['png'], { type: 'image/png' }));

  it('loads at most two at a time and caches the result', async () => {
    const got: (string | null)[] = [];
    for (let i = 0; i < 5; i++) loadThumbnail(`/t?${i}`, (s) => got.push(s));
    expect(pending).toHaveLength(2);
    expect(thumbnailStats()).toMatchObject({ running: 2, queued: 3 });
    pending[0]!.resolve(png());
    await flush();
    expect(got).toEqual(['blob:thumb-1']);
    expect(pending).toHaveLength(3);
    expect(cachedThumbnail('/t?0')).toBe('blob:thumb-1');

    // cached: answered at once, no request
    const again: (string | null)[] = [];
    loadThumbnail('/t?0', (s) => again.push(s));
    expect(again).toEqual(['blob:thumb-1']);
    expect(pending).toHaveLength(3);
  });

  it('cancelling aborts the request so it no longer holds a connection', async () => {
    const cancels = [0, 1, 2].map((i) => loadThumbnail(`/t?${i}`, () => undefined));
    expect(pending).toHaveLength(2);
    cancels.forEach((c) => c());
    expect(pending.every((p) => p.signal.aborted)).toBe(true);
    await flush();
    // the queued one was dropped, not started
    expect(pending).toHaveLength(2);
    expect(thumbnailStats()).toMatchObject({ running: 0, queued: 0 });
  });

  it('two cards with the same thumbnail share one request', async () => {
    const a: (string | null)[] = [];
    const b: (string | null)[] = [];
    const cancelA = loadThumbnail('/t?x', (s) => a.push(s));
    loadThumbnail('/t?x', (s) => b.push(s));
    expect(pending).toHaveLength(1);
    cancelA();
    expect(pending[0]!.signal.aborted).toBe(false);
    pending[0]!.resolve(png());
    await flush();
    expect(a).toEqual([]);
    expect(b).toEqual(['blob:thumb-1']);
  });

  it('a failure answers null and is not retried right away', async () => {
    const got: (string | null)[] = [];
    loadThumbnail('/t?bad', (s) => got.push(s));
    pending[0]!.resolve(new Response('{}', { status: 503 }));
    await flush();
    expect(got).toEqual([null]);
    loadThumbnail('/t?bad', (s) => got.push(s));
    expect(got).toEqual([null, null]);
    expect(pending).toHaveLength(1);
  });
});
