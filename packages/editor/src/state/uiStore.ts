/**
 * Estado local da interface (não faz parte do documento): seleção, hover, ferramenta, página ativa,
 * viewport, edição de texto e prévias de arrasto. Separado de `docStore` para que mousemove/hover
 * não re-renderizem a árvore inteira.
 */
import { create } from 'zustand';
import type { Position, PreviewState } from '@mockup/core';
import { COMPONENT_FRAME_ID } from '../components/model';

export type LeftTab = 'layers' | 'tokens' | 'components';
export type RightTab = 'design' | 'assistant' | 'scripts';

/** Contexto do modo de edição isolado do principal (para montar a visão e para voltar). */
export interface ComponentEdit {
  /** Página exibida antes de entrar. */
  fromPageId: string | null;
  /** Instância de onde se entrou (selecionada de novo ao concluir). */
  originId: string | null;
  /** Largura (px) da instância de origem: a área do principal usa a mesma. */
  width: number | null;
}

export type Tool = 'select' | 'hand' | 'frame' | 'rect' | 'text' | 'image';

export interface Viewport {
  /** Translação do mundo em px de tela. */
  x: number;
  y: number;
  /** Zoom (1 = 100%). */
  z: number;
}

/** Prévia transitória de um nó durante arrasto/redimensionamento (descartada ao confirmar a op). */
export interface NodePreview {
  /** Posição prévia (frames raiz e filhos absolutos). */
  position?: Position;
  /** Estilos prévios sobrepostos aos do nó (ex.: width/height/left/top). */
  style?: Record<string, string>;
}

/** Pedido para o canvas enquadrar nós (ex.: seleção vinda do MCP, Shift+2). */
export interface FocusRequest {
  nodeIds: string[];
  /** Incrementado a cada pedido para disparar o efeito mesmo com os mesmos ids. */
  nonce: number;
  /** `true` = apenas rolar até os nós se estiverem fora da tela, sem mudar o zoom. */
  soft?: boolean;
}

export interface UiState {
  selection: string[];
  hoverId: string | null;
  tool: Tool;
  /** Página exibida (null = primeira do documento). */
  pageId: string | null;
  viewport: Viewport;
  /** Nó de texto em edição inline. */
  editingTextId: string | null;
  preview: Record<string, NodePreview>;
  focusRequest: FocusRequest | null;
  /** Espaço pressionado (pan temporário). */
  spaceDown: boolean;
  /** Alt pressionado (régua de distância / redimensionar pelo centro). */
  altDown: boolean;
  /** Aba ativa do painel esquerdo. */
  leftTab: LeftTab;
  /** Aba ativa do painel direito (Design = propriedades, Assistente, Scripts). */
  rightTab: RightTab;
  /** Prévia de estado (hover, focus, dark...) aplicada a todos os nós do canvas; null = nenhuma. */
  previewState: PreviewState | null;
  /** Seção Classes: mostra o estilo atual como classes Tailwind (somente leitura). */
  showAsTailwind: boolean;
  /** Mensagem transitória para o usuário (erros de op, avisos). */
  toast: { text: string; kind: 'info' | 'error'; at: number } | null;
  /** Principal em edição no modo isolado (null = fora do modo). */
  editingComponentId: string | null;
  /** Contexto do modo de edição (presente junto com `editingComponentId`). */
  componentEdit: ComponentEdit | null;
}

export const useUi = create<UiState>(() => ({
  selection: [],
  hoverId: null,
  tool: 'select',
  pageId: null,
  viewport: { x: 0, y: 0, z: 1 },
  editingTextId: null,
  preview: {},
  focusRequest: null,
  spaceDown: false,
  altDown: false,
  leftTab: 'layers',
  rightTab: 'design',
  previewState: null,
  showAsTailwind: false,
  toast: null,
  editingComponentId: null,
  componentEdit: null,
}));

/** O quadro sintético do modo de edição nunca entra na seleção. */
const selectable = (ids: string[]): string[] =>
  ids.includes(COMPONENT_FRAME_ID) ? ids.filter((id) => id !== COMPONENT_FRAME_ID) : ids;

let focusNonce = 0;

export const ui = {
  /** Define a seleção local. A publicação ao daemon é feita pelo cliente (assinatura). */
  select(ids: string[]): void {
    ids = selectable(ids);
    const cur = useUi.getState().selection;
    if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return;
    useUi.setState({ selection: ids });
  },
  toggle(id: string): void {
    if (id === COMPONENT_FRAME_ID) return;
    const cur = useUi.getState().selection;
    useUi.setState({ selection: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  hover(id: string | null): void {
    if (useUi.getState().hoverId !== id) useUi.setState({ hoverId: id });
  },
  setTool(tool: Tool): void {
    useUi.setState({ tool });
  },
  /** Troca a página exibida; sair para outra página encerra o modo de edição do principal. */
  setPage(pageId: string | null): void {
    const leaving = useUi.getState().editingComponentId !== null;
    useUi.setState({
      pageId,
      selection: [],
      hoverId: null,
      editingTextId: null,
      ...(leaving ? { editingComponentId: null, componentEdit: null } : {}),
    });
  },
  setViewport(v: Viewport | ((v: Viewport) => Viewport)): void {
    const next = typeof v === 'function' ? v(useUi.getState().viewport) : v;
    useUi.setState({ viewport: next });
  },
  focus(nodeIds: string[], soft = false): void {
    useUi.setState({ focusRequest: { nodeIds, nonce: ++focusNonce, soft } });
  },
  setPreview(preview: Record<string, NodePreview>): void {
    useUi.setState({ preview });
  },
  clearPreview(): void {
    if (Object.keys(useUi.getState().preview).length) useUi.setState({ preview: {} });
  },
  /**
   * Remove só as entradas que ainda são as de `mine` (a última prévia que um gesto definiu):
   * um gesto novo, iniciado antes do ack do anterior, mantém a própria prévia.
   */
  releasePreview(mine: Record<string, NodePreview>): void {
    const cur = useUi.getState().preview;
    const owned = Object.keys(mine).filter((id) => cur[id] === mine[id]);
    if (!owned.length) return;
    const next = { ...cur };
    for (const id of owned) delete next[id];
    useUi.setState({ preview: next });
  },
  setLeftTab(leftTab: LeftTab): void {
    if (useUi.getState().leftTab !== leftTab) useUi.setState({ leftTab });
  },
  setRightTab(rightTab: RightTab): void {
    if (useUi.getState().rightTab !== rightTab) useUi.setState({ rightTab });
  },
  setPreviewState(previewState: PreviewState | null): void {
    if (useUi.getState().previewState !== previewState) useUi.setState({ previewState });
  },
  setShowAsTailwind(showAsTailwind: boolean): void {
    useUi.setState({ showAsTailwind });
  },
  editText(id: string | null): void {
    useUi.setState({ editingTextId: id });
  },
  toast(text: string, kind: 'info' | 'error' = 'info'): void {
    useUi.setState({ toast: { text, kind, at: Date.now() } });
  },
};
