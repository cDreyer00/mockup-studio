/**
 * Structural sharing: the daemon sends the whole document on every `doc:changed`, and each
 * object arrives new (JSON). `shareStructure` reuses the objects of the previous document that did not
 * change, so that `React.memo` by node identity avoids re-rendering untouched nodes.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns `next`, reusing from `prev` every deeply equal subtree. */
export function shareStructure<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item, i) => {
      const shared = i < prev.length ? shareStructure(prev[i], item) : item;
      if (shared !== prev[i]) same = false;
      return shared;
    });
    return (same ? prev : out) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const pk = Object.keys(prev);
    const nk = Object.keys(next);
    let same = pk.length === nk.length;
    const out: Record<string, unknown> = {};
    for (const k of nk) {
      const shared = k in prev ? shareStructure(prev[k], next[k]) : next[k];
      if (!(k in prev) || shared !== prev[k]) same = false;
      out[k] = shared;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
