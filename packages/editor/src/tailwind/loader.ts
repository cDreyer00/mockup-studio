/**
 * Carga sob demanda do motor Tailwind (`@mockup/core/tailwind`, ~260 kB com o compilador oficial):
 * só é baixado quando o painel de classes é aberto ou quando se cola HTML com classes.
 */
import type { Document } from '@mockup/core';

import type * as TailwindNs from '@mockup/core/tailwind';

export type TailwindModule = typeof TailwindNs;
export type TailwindEngine = Awaited<ReturnType<TailwindModule['getTailwindEngine']>>;

let modulePromise: Promise<TailwindModule> | null = null;
let loaded: TailwindModule | null = null;

/** Módulo do motor (importado uma vez; uma falha pode ser tentada de novo). */
export function loadTailwindModule(): Promise<TailwindModule> {
  modulePromise ??= import('@mockup/core/tailwind').then(
    (m) => (loaded = m),
    (e: unknown) => {
      modulePromise = null;
      throw e;
    },
  );
  return modulePromise;
}

/** Motor do documento (cache por tokens/temas, no próprio core). */
export async function loadTailwindEngine(
  doc: Pick<Document, 'tokens' | 'themes'>,
): Promise<{ mod: TailwindModule; engine: TailwindEngine }> {
  const mod = await loadTailwindModule();
  return { mod, engine: await mod.getTailwindEngine(doc) };
}

/** Motor já pronto (sem esperar), se o módulo e o motor do documento já foram carregados. */
export function peekEngine(doc: Pick<Document, 'tokens' | 'themes'>): TailwindEngine | undefined {
  return loaded?.peekTailwindEngine(doc);
}
