// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetThumbnails, thumbnailStats, useThumbnail } from './thumbnails';

interface Pending {
  url: string;
  signal: AbortSignal;
  resolve: (r: Response) => void;
}

describe('useThumbnail', () => {
  let pending: Pending[];
  let created = 0;
  beforeEach(() => {
    pending = [];
    created = 0;
    resetThumbnails();
    // no layout in happy-dom: thumbnails load right away
    vi.stubGlobal('IntersectionObserver', undefined);
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
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:thumb-${++created}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    resetThumbnails();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const png = () => new Response(new Blob(['png'], { type: 'image/png' }));
  const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
  const ref = { current: null };

  it('keeps the previous image while the new version loads, then swaps', async () => {
    const { result, rerender } = renderHook(({ url }) => useThumbnail(url, ref), {
      initialProps: { url: '/t?path=a&v=1' },
    });
    expect(result.current).toEqual({ src: undefined, failed: false });
    pending[0]!.resolve(png());
    await settle();
    expect(result.current).toEqual({ src: 'blob:thumb-1', failed: false });

    // saved: new mtime, new URL; the old image stays until the new one arrives
    rerender({ url: '/t?path=a&v=2' });
    expect(result.current).toEqual({ src: 'blob:thumb-1', failed: false });
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(png());
    await settle();
    expect(result.current).toEqual({ src: 'blob:thumb-2', failed: false });
  });

  it('keeps the previous image when the new version fails', async () => {
    const { result, rerender } = renderHook(({ url }) => useThumbnail(url, ref), {
      initialProps: { url: '/t?path=a&v=1' },
    });
    pending[0]!.resolve(png());
    await settle();
    rerender({ url: '/t?path=a&v=2' });
    pending[1]!.resolve(new Response('{}', { status: 503 }));
    await settle();
    expect(result.current).toEqual({ src: 'blob:thumb-1', failed: false });
  });

  it('a new version requested before the previous one landed aborts it', async () => {
    const { result, rerender } = renderHook(({ url }) => useThumbnail(url, ref), {
      initialProps: { url: '/t?path=a&v=1' },
    });
    rerender({ url: '/t?path=a&v=2' });
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[1]!.resolve(png());
    await settle();
    expect(result.current).toEqual({ src: 'blob:thumb-1', failed: false });
    expect(thumbnailStats()).toMatchObject({ running: 0, queued: 0 });
  });

  it('without an earlier image a failure is reported', async () => {
    const { result } = renderHook(() => useThumbnail('/t?path=b&v=1', ref));
    pending[0]!.resolve(new Response('{}', { status: 503 }));
    await settle();
    expect(result.current).toEqual({ src: undefined, failed: true });
  });
});
