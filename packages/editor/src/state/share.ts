/**
 * Compartilhamento estrutural: o daemon manda o documento completo a cada `doc:changed`, e cada
 * objeto chega novo (JSON). `shareStructure` reaproveita os objetos do documento anterior que não
 * mudaram, para que `React.memo` por identidade de nó evite re-render dos nós intocados.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Devolve `next`, reaproveitando de `prev` cada subárvore profundamente igual. */
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
