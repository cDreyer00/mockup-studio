/**
 * Loading of the home screen file list (`GET /api/files`).
 *
 * - The last result of each query stays in a module-level cache: the home screen shows it at once
 *   when it mounts again (e.g. after going back from a document) and refreshes in the background.
 * - One request in flight at a time: a reload asked for meanwhile runs when it finishes, so a
 *   stream of changes never cancels the request that is about to land (no starvation).
 * - Reloads caused by open document changes are throttled (`throttleMs`).
 * - A request that fails or takes longer than `timeoutMs` becomes an error (with retry), never a
 *   silent empty screen.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, queryString } from '../client/api';
import type { FilesQuery, FilesResult } from '../client/api';

export interface FilesListState {
  /** Key of the current query (see `filesQueryKey`). */
  key: string;
  /** Last result of the current query (cached or fresh); `null` while nothing has arrived yet. */
  data: FilesResult | null;
  error: string | null;
  /** A request for the current query is in flight. */
  loading: boolean;
}

export interface FilesListOptions {
  fetch?: (query: FilesQuery, signal: AbortSignal) => Promise<FilesResult>;
  /** Time limit of a request before it becomes an error (ms). */
  timeoutMs?: number;
  /** Minimum interval between reloads caused by document changes (ms). */
  throttleMs?: number;
  /** Delay before querying while the search text changes (ms). */
  debounceMs?: number;
  cache?: Map<string, FilesResult>;
}

export const LIST_TIMEOUT_MS = 10_000;
export const DOCUMENTS_THROTTLE_MS = 500;
export const SEARCH_DEBOUNCE_MS = 120;

const sharedCache = new Map<string, FilesResult>();

/** Clears the shared cache (tests). */
export function clearFilesListCache(): void {
  sharedCache.clear();
}

export function filesQueryKey(q: FilesQuery): string {
  return queryString({
    folder: q.folder,
    tag: q.tag,
    query: q.query,
    favorites: q.favorites,
    recursive: q.recursive,
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface InFlight {
  seq: number;
  key: string;
  ctrl: AbortController;
}

export class FilesListController {
  private state: FilesListState;
  private query: FilesQuery;
  private readonly listeners = new Set<() => void>();
  private readonly cache: Map<string, FilesResult>;
  private readonly fetcher: (query: FilesQuery, signal: AbortSignal) => Promise<FilesResult>;
  private readonly timeoutMs: number;
  private readonly throttleMs: number;
  private readonly debounceMs: number;
  private seq = 0;
  /** Sequence of the last response applied to the current query. */
  private applied = 0;
  private inflight: InFlight | null = null;
  /** A reload was asked for while a request was in flight. */
  private rerun = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDocumentsReload = -Infinity;
  private active = false;

  constructor(query: FilesQuery, opts: FilesListOptions = {}) {
    this.cache = opts.cache ?? sharedCache;
    this.fetcher = opts.fetch ?? ((q, signal) => api.files.list(q, signal));
    this.timeoutMs = opts.timeoutMs ?? LIST_TIMEOUT_MS;
    this.throttleMs = opts.throttleMs ?? DOCUMENTS_THROTTLE_MS;
    this.debounceMs = opts.debounceMs ?? SEARCH_DEBOUNCE_MS;
    this.query = query;
    const key = filesQueryKey(query);
    this.state = { key, data: this.cache.get(key) ?? null, error: null, loading: false };
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly getState = (): FilesListState => this.state;

  /** Starts (or restarts, after `dispose`) and loads the current query. */
  start(): void {
    this.active = true;
    this.load();
  }

  /** Changes the query: shows its cached result at once and loads it (`debounce`: search typing). */
  setQuery(query: FilesQuery, opts: { debounce?: boolean } = {}): void {
    const key = filesQueryKey(query);
    this.query = query;
    if (key === this.state.key) return;
    // the old query's response would only feed the cache: free the connection
    if (this.inflight && this.inflight.key !== key) {
      this.inflight.ctrl.abort();
      this.inflight = null;
    }
    this.rerun = false;
    this.applied = 0;
    this.clearDebounce();
    this.set({ key, data: this.cache.get(key) ?? null, error: null, loading: false });
    if (!this.active) return;
    if (opts.debounce) this.debounceTimer = setTimeout(() => this.load(), this.debounceMs);
    else this.load();
  }

  /** Reloads now (after a change made from the home screen, or Retry). */
  refresh(): void {
    if (!this.active) return;
    this.clearDebounce();
    this.load();
  }

  /** An open document changed in a way that matters to the list: reloads, throttled. */
  documentsChanged(): void {
    if (!this.active || this.throttleTimer) return;
    const wait = this.lastDocumentsReload + this.throttleMs - Date.now();
    const run = (): void => {
      this.throttleTimer = null;
      this.lastDocumentsReload = Date.now();
      this.load();
    };
    if (wait <= 0) run();
    else this.throttleTimer = setTimeout(run, wait);
  }

  /** Stops: aborts the request in flight (frees the connection) and the timers. */
  dispose(): void {
    this.active = false;
    this.rerun = false;
    this.clearDebounce();
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
    if (this.inflight) {
      this.inflight.ctrl.abort();
      this.inflight = null;
      this.set({ ...this.state, loading: false });
    }
  }

  private load(): void {
    if (!this.active) return;
    this.clearDebounce();
    if (this.inflight) {
      // never cancel the request about to land: run again once it does
      this.rerun = true;
      return;
    }
    const seq = ++this.seq;
    const key = this.state.key;
    const ctrl = new AbortController();
    const flight: InFlight = { seq, key, ctrl };
    this.inflight = flight;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    this.set({ ...this.state, loading: true });

    const settle = (apply: () => void): void => {
      clearTimeout(timer);
      if (this.inflight === flight) this.inflight = null;
      else return; // replaced (query changed or disposed)
      if (key === this.state.key && seq > this.applied) apply();
      if (this.rerun && this.active) {
        this.rerun = false;
        this.load();
      } else if (this.state.loading) this.set({ ...this.state, loading: false });
    };

    let promise: Promise<FilesResult>;
    try {
      promise = this.fetcher(this.query, ctrl.signal);
    } catch (e) {
      promise = Promise.reject(e);
    }
    promise.then(
      (r) => {
        this.cache.set(key, r);
        settle(() => {
          this.applied = seq;
          this.set({ ...this.state, data: r, error: null });
        });
      },
      (e: unknown) => {
        settle(() => {
          // a newer reload is queued: let it try before showing an error
          if (this.rerun && !timedOut) return;
          this.set({
            ...this.state,
            error: timedOut ? 'The file list is taking too long to load.' : errorText(e),
          });
        });
      },
    );
  }

  private clearDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private set(state: FilesListState): void {
    this.state = state;
    for (const fn of this.listeners) fn();
  }
}

/**
 * File list of the home screen. `search` changes are debounced; other query changes load at once.
 * `documentsSignature` changes (open/close/save/path of open documents) reload, throttled.
 */
export function useFilesList(
  query: FilesQuery,
  search: string,
  documentsSignature: string,
  opts?: FilesListOptions,
): FilesListState & { reload: () => void } {
  const [controller] = useState(() => new FilesListController(query, opts));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  const lastSearch = useRef(search);
  const key = filesQueryKey(query);
  useEffect(() => {
    const debounce = lastSearch.current !== search;
    lastSearch.current = search;
    controller.setQuery(query, { debounce });
    // `query` is described by `key`
  }, [controller, key, search]);

  const lastSignature = useRef(documentsSignature);
  useEffect(() => {
    if (lastSignature.current === documentsSignature) return;
    lastSignature.current = documentsSignature;
    controller.documentsChanged();
  }, [controller, documentsSignature]);

  return { ...state, reload: () => controller.refresh() };
}
