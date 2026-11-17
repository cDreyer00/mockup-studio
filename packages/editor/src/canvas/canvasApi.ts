/**
 * Imperative canvas API for the other areas (shortcuts, toolbar, clipboard).
 * The canvas component registers the real implementation on mount (`registerCanvasApi`).
 */
export interface CanvasApi {
  zoomIn(): void;
  zoomOut(): void;
  /** Sets the zoom (1 = 100%) keeping the screen center. */
  zoomTo(z: number): void;
  /** Shift+1: fits all visible frames on the page. */
  fitAll(): void;
  /** Shift+2: fits the nodes (default: the selection). */
  fitNodes(ids?: string[]): void;
  /** Center of the visible area in world coordinates (for insert/paste). */
  viewportCenter(): { x: number; y: number };
  /** Rectangle of a node in world coordinates (measured from the DOM), or null if not rendered. */
  nodeRect(id: string): { x: number; y: number; w: number; h: number } | null;
}

const noop = (): void => undefined;

const fallback: CanvasApi = {
  zoomIn: noop,
  zoomOut: noop,
  zoomTo: noop,
  fitAll: noop,
  fitNodes: noop,
  viewportCenter: () => ({ x: 0, y: 0 }),
  nodeRect: () => null,
};

let impl: CanvasApi = fallback;

/** Registers the implementation; returns the function that removes it. */
export function registerCanvasApi(api: CanvasApi): () => void {
  impl = api;
  return () => {
    if (impl === api) impl = fallback;
  };
}

/** Stable proxy: always calls the implementation currently registered. */
export const canvasApi: CanvasApi = {
  zoomIn: () => impl.zoomIn(),
  zoomOut: () => impl.zoomOut(),
  zoomTo: (z) => impl.zoomTo(z),
  fitAll: () => impl.fitAll(),
  fitNodes: (ids) => impl.fitNodes(ids),
  viewportCenter: () => impl.viewportCenter(),
  nodeRect: (id) => impl.nodeRect(id),
};
