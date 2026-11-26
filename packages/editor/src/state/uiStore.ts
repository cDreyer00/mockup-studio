/**
 * Local UI state (not part of the document): selection, hover, tool, active page,
 * viewport, text editing and drag previews. Kept separate from `docStore` so that mousemove/hover
 * do not re-render the whole tree.
 */
import { create } from 'zustand';
import type { ImageCrop, Position, PreviewState } from '@mockup/core';
import { COMPONENT_FRAME_ID } from '../components/model';

export type LeftTab = 'layers' | 'assets' | 'components' | 'tokens';
export type RightTab = 'design' | 'assistant' | 'scripts';

/** Context of the isolated main component edit mode (to build the view and to go back). */
export interface ComponentEdit {
  /** Page displayed before entering. */
  fromPageId: string | null;
  /** Instance entered from (selected again when done). */
  originId: string | null;
  /** Width (px) of the source instance: the main component area uses the same one. */
  width: number | null;
}

export type Tool =
  'select' | 'hand' | 'frame' | 'rect' | 'text' | 'image' | 'pen' | 'ellipse' | 'line' | 'polygon';

export interface Viewport {
  /** World translation in screen px. */
  x: number;
  y: number;
  /** Zoom (1 = 100%). */
  z: number;
}

/** Transient preview of a node during drag/resize (discarded when the op is confirmed). */
export interface NodePreview {
  /** Preview position (root frames and absolute children). */
  position?: Position;
  /** Preview styles overlaid on the node's own (e.g. width/height/left/top). */
  style?: Record<string, string>;
}

/** Request for the canvas to frame nodes (e.g. selection coming from the MCP, Shift+2). */
export interface FocusRequest {
  nodeIds: string[];
  /** Incremented on every request to trigger the effect even with the same ids. */
  nonce: number;
  /** `true` = only scroll to the nodes if they are off screen, without changing the zoom. */
  soft?: boolean;
}

export interface UiState {
  selection: string[];
  hoverId: string | null;
  tool: Tool;
  /** Displayed page (null = first of the document). */
  pageId: string | null;
  viewport: Viewport;
  /** Text node being edited inline. */
  editingTextId: string | null;
  /** SVG node in point editing (vector edit mode). */
  editingVectorId: string | null;
  preview: Record<string, NodePreview>;
  focusRequest: FocusRequest | null;
  /** Image in visual crop mode (null = outside the mode). */
  cropNodeId: string | null;
  /** Crop being edited (% of each side) while `cropNodeId` is active. */
  cropDraft: ImageCrop | null;
  /** Space pressed (temporary pan). */
  spaceDown: boolean;
  /** Alt pressed (distance ruler / resize from the center). */
  altDown: boolean;
  /** Active tab of the left panel. */
  leftTab: LeftTab;
  /** Active tab of the right panel (Design = properties, Assistant, Scripts). */
  rightTab: RightTab;
  /** State preview (hover, focus, dark...) applied to all canvas nodes; null = none. */
  previewState: PreviewState | null;
  /** Classes section: shows the current style as Tailwind classes (read-only). */
  showAsTailwind: boolean;
  /** Transient message for the user (op errors, notices). */
  toast: { text: string; kind: 'info' | 'error'; at: number } | null;
  /** Main component being edited in isolated mode (null = outside the mode). */
  editingComponentId: string | null;
  /** Edit mode context (present together with `editingComponentId`). */
  componentEdit: ComponentEdit | null;
  /** Home screen (files) shown in place of the canvas. */
  homeOpen: boolean;
  /** Motion timeline panel (bottom of the canvas area) open. */
  motionOpen: boolean;
  /** Height (px) of the motion timeline panel. */
  motionHeight: number;
  /** Animation selected in the timeline (highlighted in the Animation section). */
  motionSelection: MotionSelection | null;
}

/** An animation of a node: `index` in `node.animations`. */
export interface MotionSelection {
  nodeId: string;
  index: number;
}

export const useUi = create<UiState>(() => ({
  selection: [],
  hoverId: null,
  tool: 'select',
  pageId: null,
  viewport: { x: 0, y: 0, z: 1 },
  editingTextId: null,
  editingVectorId: null,
  preview: {},
  cropNodeId: null,
  cropDraft: null,
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
  homeOpen: false,
  motionOpen: false,
  motionHeight: 220,
  motionSelection: null,
}));

/** The synthetic frame of edit mode never enters the selection. */
const selectable = (ids: string[]): string[] =>
  ids.includes(COMPONENT_FRAME_ID) ? ids.filter((id) => id !== COMPONENT_FRAME_ID) : ids;

let focusNonce = 0;

export const ui = {
  /** Sets the local selection. Publishing it to the daemon is done by the client (subscription). */
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
  /** Switches the displayed page; leaving for another page ends main component edit mode. */
  setPage(pageId: string | null): void {
    const leaving = useUi.getState().editingComponentId !== null;
    useUi.setState({
      pageId,
      selection: [],
      hoverId: null,
      editingTextId: null,
      ...(leaving ? { editingComponentId: null, componentEdit: null } : {}),
      editingVectorId: null,
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
   * Removes only the entries that are still those of `mine` (the last preview a gesture set):
   * a new gesture, started before the previous one's ack, keeps its own preview.
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
  /** Enters crop mode for image `id` with the initial crop `initial`. */
  startCrop(id: string, initial: ImageCrop): void {
    useUi.setState({ cropNodeId: id, cropDraft: initial, editingTextId: null });
  },
  setCropDraft(crop: ImageCrop): void {
    useUi.setState({ cropDraft: crop });
  },
  /** Leaves crop mode (the preview is cleared by whoever calls `endCrop`). */
  endCrop(): void {
    useUi.setState({ cropNodeId: null, cropDraft: null });
  },
  editText(id: string | null): void {
    useUi.setState({ editingTextId: id });
  },
  setHome(open: boolean): void {
    if (useUi.getState().homeOpen !== open) useUi.setState({ homeOpen: open });
  },
  /** Enters (id) or leaves (null) point editing of an SVG node. */
  editVector(id: string | null): void {
    if (useUi.getState().editingVectorId !== id) useUi.setState({ editingVectorId: id });
  },
  setMotionOpen(motionOpen: boolean): void {
    if (useUi.getState().motionOpen !== motionOpen) useUi.setState({ motionOpen });
  },
  toggleMotion(): void {
    useUi.setState({ motionOpen: !useUi.getState().motionOpen });
  },
  setMotionHeight(h: number): void {
    useUi.setState({ motionHeight: Math.round(Math.min(Math.max(h, 120), 640)) });
  },
  selectMotion(motionSelection: MotionSelection | null): void {
    useUi.setState({ motionSelection });
  },
  toast(text: string, kind: 'info' | 'error' = 'info'): void {
    useUi.setState({ toast: { text, kind, at: Date.now() } });
  },
};
