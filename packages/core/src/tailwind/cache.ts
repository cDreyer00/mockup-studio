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

const warmed = new WeakSet<TailwindEngine>();

/**
 * Aquece o motor em ocioso (uma vez por motor), sem bloquear quem pediu: `requestIdleCallback` no
 * navegador, `setTimeout(0)` no Node (depois de a resposta sair). Assim o primeiro `get_code` ou
 * "Mostrar como Tailwind" não paga a montagem dos índices da canonicalização.
 */
function scheduleWarmup(engine: TailwindEngine): void {
  if (warmed.has(engine)) return;
  warmed.add(engine);
  const run = (): void => {
    try {
      engine.warmup();
    } catch {
      /* o aquecimento é só otimização */
    }
  };
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => unknown })
    .requestIdleCallback;
  if (typeof ric === 'function') ric.call(globalThis, run);
  else setTimeout(run, 0);
}

/**
 * Motor do documento (criado na primeira chamada; depois vem do cache). `warmup: false` não agenda
 * o aquecimento em ocioso do motor recém-criado.
 */
export function getTailwindEngine(
  doc: Pick<Document, 'tokens' | 'themes'>,
  options: { warmup?: boolean } = {},
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
        if (options.warmup !== false) scheduleWarmup(engine);
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
