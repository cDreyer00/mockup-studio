import { useEffect, useState } from 'react';
import { useDoc } from '../state/docStore';
import { loadTailwindEngine } from './loader';
import type { TailwindEngine, TailwindModule } from './loader';

export type TailwindState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; engine: TailwindEngine; mod: TailwindModule };

/**
 * Motor Tailwind do documento ativo, carregado sob demanda. Troca de motor quando os tokens/temas
 * mudam (mantendo o anterior até o novo ficar pronto, sem piscar "Carregando").
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
