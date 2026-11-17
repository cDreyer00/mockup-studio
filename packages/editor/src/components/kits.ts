/** Component kits from the daemon: `GET /api/kits` (list) and `GET /api/kits/:name` (document). */
import type { Document, PropDef } from '@mockup/core';

export interface KitComponentInfo {
  id: string;
  name: string;
  description?: string;
  props: PropDef[];
}

export interface KitInfo {
  name: string;
  components: KitComponentInfo[];
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${url}: ${res.status}`);
  return body;
}

let kitsPromise: Promise<KitInfo[]> | null = null;
const kitDocs = new Map<string, Promise<Document>>();

/** Kits available in the daemon (cached; a failure is not cached). */
export function fetchKits(): Promise<KitInfo[]> {
  kitsPromise ??= getJson('/api/kits')
    .then((body) => {
      const kits = (body as { kits?: KitInfo[] }).kits;
      if (!Array.isArray(kits)) throw new Error('Invalid response from /api/kits');
      return kits;
    })
    .catch((e: unknown) => {
      kitsPromise = null;
      throw e;
    });
  return kitsPromise;
}

/** Kit document (components and tokens), for `importKitOps`. Cached. */
export function fetchKit(name: string): Promise<Document> {
  let p = kitDocs.get(name);
  if (!p) {
    p = getJson(`/api/kits/${encodeURIComponent(name)}`)
      .then((body) => {
        const doc = body as Document;
        if (!Array.isArray(doc.components)) throw new Error(`Kit "${name}" has no components`);
        return doc;
      })
      .catch((e: unknown) => {
        kitDocs.delete(name);
        throw e;
      });
    kitDocs.set(name, p);
  }
  return p;
}

/** Clears the caches (tests). */
export function resetKitCache(): void {
  kitsPromise = null;
  kitDocs.clear();
}
