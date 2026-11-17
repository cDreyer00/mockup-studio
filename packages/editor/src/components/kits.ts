/** Kits de componentes do daemon: `GET /api/kits` (lista) e `GET /api/kits/:name` (documento). */
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

/** Kits disponíveis no daemon (em cache; uma falha não fica em cache). */
export function fetchKits(): Promise<KitInfo[]> {
  kitsPromise ??= getJson('/api/kits')
    .then((body) => {
      const kits = (body as { kits?: KitInfo[] }).kits;
      if (!Array.isArray(kits)) throw new Error('Resposta inválida de /api/kits');
      return kits;
    })
    .catch((e: unknown) => {
      kitsPromise = null;
      throw e;
    });
  return kitsPromise;
}

/** Documento do kit (componentes e tokens), para `importKitOps`. Em cache. */
export function fetchKit(name: string): Promise<Document> {
  let p = kitDocs.get(name);
  if (!p) {
    p = getJson(`/api/kits/${encodeURIComponent(name)}`)
      .then((body) => {
        const doc = body as Document;
        if (!Array.isArray(doc.components)) throw new Error(`Kit "${name}" sem componentes`);
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

/** Limpa os caches (testes). */
export function resetKitCache(): void {
  kitsPromise = null;
  kitDocs.clear();
}
