import type { Document } from '../types.js';
import { createTailwindEngine, tailwindEngineKey, type TailwindEngine } from './engine.js';

/**
 * Cache dos motores por chave de tokens (`tailwindEngineKey`): o mesmo documento reaproveita o
 * compilador até os tokens do `@theme` mudarem (aí a chave muda e um novo motor é criado).
 * Guarda os últimos 8 motores e deduplica criações simultâneas.
 */
const MAX = 8;
const ready = new Map<string, TailwindEngine>();
const pending = new Map<string, Promise<TailwindEngine>>();

function remember(key: string, engine: TailwindEngine): void {
  ready.delete(key);
  ready.set(key, engine);
  while (ready.size > MAX) ready.delete(ready.keys().next().value!);
}

/** Motor do documento (criado na primeira chamada; depois vem do cache). */
export function getTailwindEngine(
  doc: Pick<Document, 'tokens' | 'themes'>,
): Promise<TailwindEngine> {
  const key = tailwindEngineKey(doc);
  const hit = ready.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  let p = pending.get(key);
  if (!p) {
    p = createTailwindEngine(doc)
      .then((engine) => {
        remember(key, engine);
        return engine;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/** Motor já pronto para o documento, sem esperar (`undefined` se ainda não foi criado). */
export function peekTailwindEngine(
  doc: Pick<Document, 'tokens' | 'themes'>,
): TailwindEngine | undefined {
  return ready.get(tailwindEngineKey(doc));
}

/** Esvazia o cache (testes). */
export function clearTailwindEngines(): void {
  ready.clear();
  pending.clear();
}
