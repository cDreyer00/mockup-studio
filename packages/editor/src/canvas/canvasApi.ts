/**
 * API imperativa do canvas para as outras áreas (atalhos, barra de ferramentas, clipboard).
 * O componente do canvas registra a implementação real ao montar (`registerCanvasApi`).
 */
export interface CanvasApi {
  zoomIn(): void;
  zoomOut(): void;
  /** Define o zoom (1 = 100%) mantendo o centro da tela. */
  zoomTo(z: number): void;
  /** Shift+1: enquadra todos os frames visíveis da página. */
  fitAll(): void;
  /** Shift+2: enquadra os nós (padrão: a seleção). */
  fitNodes(ids?: string[]): void;
  /** Centro da área visível em coordenadas do mundo (para inserir/colar). */
  viewportCenter(): { x: number; y: number };
  /** Retângulo de um nó em coordenadas do mundo (medido no DOM), ou null se não renderizado. */
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

/** Registra a implementação; devolve a função que a remove. */
export function registerCanvasApi(api: CanvasApi): () => void {
  impl = api;
  return () => {
    if (impl === api) impl = fallback;
  };
}

/** Proxy estável: sempre chama a implementação registrada no momento. */
export const canvasApi: CanvasApi = {
  zoomIn: () => impl.zoomIn(),
  zoomOut: () => impl.zoomOut(),
  zoomTo: (z) => impl.zoomTo(z),
  fitAll: () => impl.fitAll(),
  fitNodes: (ids) => impl.fitNodes(ids),
  viewportCenter: () => impl.viewportCenter(),
  nodeRect: (id) => impl.nodeRect(id),
};
