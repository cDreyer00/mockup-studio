/** Estado local do painel de camadas (recolhidos, âncora do Shift+clique, alvo de drop). */
import { create } from 'zustand';
import type { DropZone } from './layersLogic';

export interface LayersState {
  collapsed: ReadonlySet<string>;
  anchor: string | null;
  drop: { id: string; zone: DropZone } | { id: null; zone: 'root' } | null;
}

export const useLayers = create<LayersState>(() => ({
  collapsed: new Set<string>(),
  anchor: null,
  drop: null,
}));

export const layers = {
  toggleCollapsed(id: string): void {
    const next = new Set(useLayers.getState().collapsed);
    if (!next.delete(id)) next.add(id);
    useLayers.setState({ collapsed: next });
  },
  /** Expande os ids informados (se algum estiver recolhido). */
  expand(ids: readonly string[]): void {
    const cur = useLayers.getState().collapsed;
    if (!ids.some((id) => cur.has(id))) return;
    const next = new Set(cur);
    for (const id of ids) next.delete(id);
    useLayers.setState({ collapsed: next });
  },
  setAnchor(id: string | null): void {
    useLayers.setState({ anchor: id });
  },
  setDrop(drop: LayersState['drop']): void {
    const cur = useLayers.getState().drop;
    if (cur?.id === drop?.id && cur?.zone === drop?.zone) return;
    useLayers.setState({ drop });
  },
};
