/**
 * Thumbnail loading for the home screen cards.
 *
 * Thumbnails can be slow (the desktop renders them one at a time). Plain `<img>` loads cannot be
 * cancelled: once the home screen unmounts they keep holding the browser's few connections to the
 * daemon (6 per host over HTTP/1.1) and block `GET /api/files` and the other API calls. Here they
 * are `fetch`es with an `AbortController`, at most `MAX_CONCURRENT` at a time, aborted when no card
 * needs them any more; finished ones stay as object URLs so remounts show them at once.
 */
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

const MAX_CONCURRENT = 2;
const MAX_CACHED = 300;
/** A failed thumbnail is not retried before this (ms); the URL changes when the file is saved. */
const FAILURE_TTL_MS = 60_000;

type Listener = (src: string | null) => void;

interface Job {
  url: string;
  listeners: Set<Listener>;
  ctrl: AbortController | null;
}

const done = new Map<string, string>();
const failed = new Map<string, number>();
const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

/** Object URL of an already loaded thumbnail. */
export function cachedThumbnail(url: string): string | undefined {
  const src = done.get(url);
  if (src) {
    // most recently used goes last
    done.delete(url);
    done.set(url, src);
  }
  return src;
}

function failedRecently(url: string): boolean {
  const at = failed.get(url);
  if (at === undefined) return false;
  if (Date.now() - at < FAILURE_TTL_MS) return true;
  failed.delete(url);
  return false;
}

function remember(url: string, src: string): void {
  done.set(url, src);
  while (done.size > MAX_CACHED) {
    const [oldest, old] = done.entries().next().value as [string, string];
    done.delete(oldest);
    URL.revokeObjectURL(old);
  }
}

function finish(job: Job, src: string | null): void {
  jobs.delete(job.url);
  if (src) remember(job.url, src);
  else failed.set(job.url, Date.now());
  for (const fn of job.listeners) fn(src);
}

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    const ctrl = new AbortController();
    job.ctrl = ctrl;
    running++;
    fetch(job.url, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return URL.createObjectURL(await res.blob());
      })
      .then(
        (src) => {
          if (!ctrl.signal.aborted) finish(job, src);
          else URL.revokeObjectURL(src);
        },
        () => {
          if (!ctrl.signal.aborted) finish(job, null);
        },
      )
      .finally(() => {
        running--;
        pump();
      });
  }
}

/**
 * Loads the thumbnail; `onDone` receives the object URL, or `null` if it failed. Returns the
 * cancel function: when no one waits for it any more, the request is dropped or aborted.
 */
export function loadThumbnail(url: string, onDone: Listener): () => void {
  const cached = cachedThumbnail(url);
  if (cached) {
    onDone(cached);
    return () => undefined;
  }
  if (failedRecently(url)) {
    onDone(null);
    return () => undefined;
  }
  let job = jobs.get(url);
  if (!job) {
    job = { url, listeners: new Set(), ctrl: null };
    jobs.set(url, job);
    queue.push(job);
  }
  job.listeners.add(onDone);
  const j = job;
  pump();
  return () => {
    if (!j.listeners.delete(onDone) || j.listeners.size > 0 || jobs.get(url) !== j) return;
    jobs.delete(url);
    const i = queue.indexOf(j);
    if (i >= 0) queue.splice(i, 1);
    j.ctrl?.abort();
  };
}

/** Requests in flight and queued (tests). */
export function thumbnailStats(): { running: number; queued: number; cached: number } {
  return { running, queued: queue.length, cached: done.size };
}

/** Clears the cache and failures (tests). Requests in flight are aborted. */
export function resetThumbnails(): void {
  for (const job of jobs.values()) job.ctrl?.abort();
  jobs.clear();
  queue.length = 0;
  for (const src of done.values()) URL.revokeObjectURL(src);
  done.clear();
  failed.clear();
}

/**
 * Thumbnail of a card: starts loading when the element comes near the viewport and cancels when
 * the card unmounts. `src` is the object URL (`undefined` while loading); `failed` when it failed.
 */
export function useThumbnail(
  url: string | null,
  ref: RefObject<Element | null>,
): { src: string | undefined; failed: boolean } {
  const [result, setResult] = useState<{ url: string | null; src: string | null } | null>(() =>
    url && cachedThumbnail(url) ? { url, src: cachedThumbnail(url)! } : null,
  );

  useEffect(() => {
    if (!url) return;
    let cancel: (() => void) | null = null;
    const start = (): void => {
      if (cancel) return;
      cancel = loadThumbnail(url, (src) => setResult({ url, src }));
    };
    const el = ref.current;
    let observer: IntersectionObserver | null = null;
    if (el && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            observer?.disconnect();
            start();
          }
        },
        { rootMargin: '200px' },
      );
      observer.observe(el);
    } else start();
    return () => {
      observer?.disconnect();
      cancel?.();
    };
  }, [url, ref]);

  const current = result && result.url === url ? result : null;
  return { src: current?.src ?? undefined, failed: current !== null && current.src === null };
}
