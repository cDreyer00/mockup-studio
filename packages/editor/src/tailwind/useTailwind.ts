import { useEffect, useState } from 'react';
import { useDoc } from '../state/docStore';
import { loadTailwindEngine } from './loader';
import type { TailwindEngine, TailwindModule } from './loader';

export type TailwindState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; engine: TailwindEngine; mod: TailwindModule };

/**
 * Tailwind engine of the active document, loaded on demand. Switches engine when the tokens/themes
 * change (keeping the previous one until the new one is ready, without flashing "Loading").
 */
export function useTailwind(): TailwindState {
  const tokens = useDoc((s) => s.doc?.tokens);
  const themes = useDoc((s) => s.doc?.themes);
  const [state, setState] = useState<TailwindState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    const input = { tokens: tokens ?? {}, themes };
    loadTailwindEngine(input).then(
      ({ mod, engine }) => alive && setState({ status: 'ready', engine, mod }),
      (e: unknown) =>
        alive && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [tokens, themes]);

  return state;
}
