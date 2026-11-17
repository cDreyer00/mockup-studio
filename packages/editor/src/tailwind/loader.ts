/**
 * On-demand loading of the Tailwind engine (`@mockup/core/tailwind`, ~260 kB with the official compiler):
 * it is only downloaded when the classes panel is opened or when HTML with classes is pasted.
 */
import type { Document } from '@mockup/core';

import type * as TailwindNs from '@mockup/core/tailwind';

export type TailwindModule = typeof TailwindNs;
export type TailwindEngine = Awaited<ReturnType<TailwindModule['getTailwindEngine']>>;

let modulePromise: Promise<TailwindModule> | null = null;
let loaded: TailwindModule | null = null;

/** Engine module (imported once; a failure can be retried). */
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

/** Document engine (cached by tokens/themes, in core itself). */
export async function loadTailwindEngine(
  doc: Pick<Document, 'tokens' | 'themes'>,
): Promise<{ mod: TailwindModule; engine: TailwindEngine }> {
  const mod = await loadTailwindModule();
  return { mod, engine: await mod.getTailwindEngine(doc) };
}

/** Engine that is already ready (without waiting), if the module and the document engine are already loaded. */
export function peekEngine(doc: Pick<Document, 'tokens' | 'themes'>): TailwindEngine | undefined {
  return loaded?.peekTailwindEngine(doc);
}
