/** Transient gesture effects (marquee, creation rectangle, insertion indicator), in world coordinates. */
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
