/** Efeitos transitórios de gestos (marquee, retângulo de criação, indicador de inserção), em mundo. */
import { create } from 'zustand';
import type { Rect } from './geometry';

export interface FxState {
  marquee: Rect | null;
  draw: Rect | null;
  insert: Rect | null;
}

export const useFx = create<FxState>(() => ({ marquee: null, draw: null, insert: null }));

export function clearFx(): void {
  const s = useFx.getState();
  if (s.marquee || s.draw || s.insert) useFx.setState({ marquee: null, draw: null, insert: null });
}
