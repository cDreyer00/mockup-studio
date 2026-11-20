import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesQuery, FilesResult } from '../client/api';
import { FilesListController, filesQueryKey } from './filesList';

const result = (n: number): FilesResult => ({
  files: Array.from({ length: n }, (_, i) => ({
    path: `/p/f${i}.mockup.json`,
    name: `f${i}`,
    folder: null,
    tags: [],
    favorite: false,
    open: false,
    mtime: 1,
    size: 1,
    pages: 1,
    frames: 1,
  })),
  folders: [],
  tags: [],
});

interface Call {
  query: FilesQuery;
  signal: AbortSignal;
  resolve: (r: FilesResult) => void;
  reject: (e: unknown) => void;
}

/** Fetcher whose responses the test resolves by hand. */
function manualFetch() {
  const calls: Call[] = [];
  const fetch = vi.fn((query: FilesQuery, signal: AbortSignal) => {
    return new Promise<FilesResult>((resolve, reject) => {
      calls.push({ query, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  });
  return { calls, fetch };
}

describe('FilesListController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps one request in flight and runs a queued reload when it lands', async () => {
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache: new Map() });
    c.start();
    expect(calls).toHaveLength(1);
    expect(c.getState()).toMatchObject({ data: null, loading: true });

    // document changes while the request is in flight: no cancel, no extra request
    c.documentsChanged();
    c.refresh();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(false);

    calls[0]!.resolve(result(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().data?.files).toHaveLength(1);
    // the queued reload starts right after
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(result(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState()).toMatchObject({ loading: false, error: null });
    expect(c.getState().data?.files).toHaveLength(2);
  });

  it('a stream of document changes never starves the list', async () => {
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache: new Map(), throttleMs: 500 });
    c.start();
    // a change every 50 ms for 3 s; every request takes 300 ms
    for (let t = 0; t < 3000; t += 50) {
      c.documentsChanged();
      await vi.advanceTimersByTimeAsync(50);
      for (const call of calls) if (!call.signal.aborted) call.resolve(result(calls.length));
    }
    expect(c.getState().data).not.toBeNull();
    // throttled: about one request per 500 ms, not one per change
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(calls.every((call) => !call.signal.aborted)).toBe(true);
  });

  it('throttles reloads caused by document changes', async () => {
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache: new Map(), throttleMs: 500 });
    c.start();
    calls[0]!.resolve(result(1));
    await vi.advanceTimersByTimeAsync(0);

    c.documentsChanged(); // leading
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(result(1));
    await vi.advanceTimersByTimeAsync(100);
    c.documentsChanged();
    c.documentsChanged();
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(400); // trailing, 500 ms after the leading one
    expect(calls).toHaveLength(3);
  });

  it('shows the cached result of a query at once and refreshes it', async () => {
    const cache = new Map<string, FilesResult>([[filesQueryKey({}), result(3)]]);
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache });
    expect(c.getState().data?.files).toHaveLength(3);
    c.start();
    expect(c.getState()).toMatchObject({ loading: true });
    expect(c.getState().data?.files).toHaveLength(3);
    calls[0]!.resolve(result(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().data?.files).toHaveLength(4);
    expect(cache.get(filesQueryKey({}))?.files).toHaveLength(4);
  });

  it('a query change aborts the old request and ignores its response', async () => {
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache: new Map() });
    c.start();
    c.setQuery({ favorites: true });
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.query).toEqual({ favorites: true });
    calls[1]!.resolve(result(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState()).toMatchObject({ key: '?favorites=1', loading: false });
    expect(c.getState().data?.files).toHaveLength(1);
  });

  it('debounces search changes', async () => {
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache: new Map(), debounceMs: 120 });
    c.start();
    calls[0]!.resolve(result(1));
    await vi.advanceTimersByTimeAsync(0);
    c.setQuery({ query: 'a' }, { debounce: true });
    await vi.advanceTimersByTimeAsync(60);
    c.setQuery({ query: 'ab' }, { debounce: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.query).toEqual({ query: 'ab' });
  });

  it('a request that takes too long becomes an error and keeps the data', async () => {
    const cache = new Map<string, FilesResult>([[filesQueryKey({}), result(2)]]);
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache, timeoutMs: 1000 });
    c.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(c.getState()).toMatchObject({
      loading: false,
      error: 'The file list is taking too long to load.',
    });
    expect(c.getState().data?.files).toHaveLength(2);
    // retry
    c.refresh();
    calls[1]!.resolve(result(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState()).toMatchObject({ error: null });
    expect(c.getState().data?.files).toHaveLength(5);
  });

  it('a failed request shows its error', async () => {
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache: new Map() });
    c.start();
    calls[0]!.reject(new Error('No connection to the daemon.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState()).toMatchObject({
      data: null,
      loading: false,
      error: 'No connection to the daemon.',
    });
  });

  it('dispose aborts the request in flight (frees the connection) and start reloads', async () => {
    const { calls, fetch } = manualFetch();
    const c = new FilesListController({}, { fetch, cache: new Map() });
    c.start();
    c.dispose();
    expect(calls[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState()).toMatchObject({ loading: false, error: null });
    c.documentsChanged();
    expect(calls).toHaveLength(1);
    c.start();
    expect(calls).toHaveLength(2);
  });
});
