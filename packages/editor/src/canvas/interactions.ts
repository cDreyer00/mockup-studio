/**
 * Interações do canvas (ponteiro, roda, teclado local, menu de contexto, drop) como módulo
 * imperativo: os handlers leem `useUi/useDoc.getState()` e nunca causam re-render da árvore.
 * Toda mutação do documento vira `Op`s numa única chamada `daemon.applySafe` por gesto.
 */
import { COMPONENT_EDIT_PAGE_ID, isGridContainer } from '@mockup/core';
import type { Node, Op } from '@mockup/core';
import { buildPositionOps, isFreelyPositioned, nodeXY } from '../actions';
import { daemon } from '../client/daemon';
import { COMPONENT_DRAG_TYPE, readComponentDrag } from '../components/drag';
import { insertInstance } from '../components/componentActions';
import { COMPONENT_FRAME_ID, structureBlock } from '../components/model';
import { buildNodeMenu } from '../layers/nodeMenu';
import { makeContainer, makeFrame, makeText } from '../model/factory';
import {
  getEntry,
  getNode,
  getParent,
  haveSameParent,
  isLockedDeep,
  isRoot,
  topLevel,
} from '../model/tree';
import { useDoc } from '../state/docStore';
import { currentPageId, selectPage } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import type { NodePreview } from '../state/uiStore';
import { openContextMenu } from '../ui/overlays';
import { commitCrop, startCrop } from './cropActions';
import { clientToWorld, findNodeEl, measureWorldRect } from './dom';
import { planGridMove } from './gridDrag';
import { clearFx, useFx } from './fx';
import {
  isNoopReorder,
  marqueeHits,
  normalizeRect,
  resizeRect,
  resolveClickTarget,
  resolveDoubleClick,
  resolveFlowInsert,
  scaleRectToBox,
  unionRects,
  zoomAtPoint,
} from './geometry';
import type { HandleName, Point, Rect } from './geometry';
import { insertImageFile, pickImageFile } from './imageTool';
import { buildCreateOps, flowAxis, planPlacement, siblingWorldRects } from './placement';
import { penDoubleClick, penPointerDown, penPointerMove } from './penTool';
import { createShape, isShapeTool, shapeDragRect } from './shapeTool';
import type { ShapeTool } from './shapeTool';

/** Deslocamento mínimo (px de tela) para um clique virar arrasto. */
const DRAG_THRESHOLD = 3;

const px = (n: number): string => `${Math.round(n)}px`;

interface Gesture {
  move(e: PointerEvent): void;
  /** `e` é o último evento (ou `null` se cancelado por Esc). */
  up(e: PointerEvent | null, cancelled: boolean): void;
}

function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
  );
}

/** Liga todas as interações ao elemento raiz do canvas. Devolve a função que desliga. */
export function attachInteractions(root: HTMLElement): () => void {
  let active: { gesture: Gesture; stop: () => void } | null = null;
  let localSpace = false;

  const st = useUi.getState;
  const currentDoc = () => useDoc.getState().doc;
  const toWorld = (e: { clientX: number; clientY: number }): Point =>
    clientToWorld(root, e.clientX, e.clientY);

  /* ------------------------------ cursor ------------------------------ */

  const panMode = (): boolean => localSpace || st().spaceDown || st().tool === 'hand';
  const syncCursor = (): void => {
    root.dataset.tool = st().tool;
    if (panMode()) root.dataset.pan = '1';
    else delete root.dataset.pan;
  };
  syncCursor();
  const offUi = useUi.subscribe((s, p) => {
    if (s.tool !== p.tool || s.spaceDown !== p.spaceDown) syncCursor();
  });

  /* ------------------------------ gestos ------------------------------ */

  function begin(gesture: Gesture): void {
    active?.stop();
    let last: PointerEvent | null = null;
    const onMove = (e: PointerEvent): void => {
      last = e;
      gesture.move(e);
    };
    const finish = (cancelled: boolean): void => {
      stop();
      gesture.up(cancelled ? null : last, cancelled);
    };
    const onUp = (e: PointerEvent): void => {
      last = e;
      finish(false);
    };
    const onCancel = (): void => finish(true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      delete root.dataset.panning;
      active = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    active = { gesture, stop };
    ui.hover(null);
  }

  /** Pan (botão do meio, espaço, ferramenta mão). */
  function startPan(e: PointerEvent): void {
    let lx = e.clientX;
    let ly = e.clientY;
    root.dataset.panning = '1';
    begin({
      move(ev) {
        const dx = ev.clientX - lx;
        const dy = ev.clientY - ly;
        lx = ev.clientX;
        ly = ev.clientY;
        ui.setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      },
      up() {},
    });
  }

  /** Arrasto no fundo: marquee sobre os frames raiz. */
  function startMarquee(e: PointerEvent): void {
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = toWorld(e);
    const base = e.shiftKey ? [...st().selection] : [];
    let items: { id: string; rect: Rect }[] | null = null;
    let moved = false;
    begin({
      move(ev) {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        moved = true;
        if (!items) {
          const doc = currentDoc();
          const frames = doc ? (selectPage(doc, st().pageId)?.frames ?? []) : [];
          items = [];
          for (const f of frames) {
            if (f.hidden || f.locked || f.id === COMPONENT_FRAME_ID) continue;
            const rect = measureWorldRect(root, f.id);
            if (rect) items.push({ id: f.id, rect });
          }
        }
        const rect = normalizeRect(startW, toWorld(ev));
        useFx.setState({ marquee: rect });
        ui.select([...new Set([...base, ...marqueeHits(items, rect)])]);
      },
      up(_e, cancelled) {
        clearFx();
        if (!moved && !cancelled && !e.shiftKey) ui.select([]);
      },
    });
  }

  /** Arrasto de nós selecionados: frames/absolutos movem; filhos em fluxo reordenam. */
  function startMove(e: PointerEvent, selectOnUp: string | null): void {
    const startX = e.clientX;
    const startY = e.clientY;
    let tried = false;
    let plan: { update(ev: PointerEvent): void; commit(cancelled: boolean): Promise<void> } | null =
      null;
    begin({
      move(ev) {
        if (!plan) {
          if (tried) return;
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
          tried = true;
          plan = planMove(startX, startY);
          if (!plan) return;
        }
        plan.update(ev);
      },
      up(_e, cancelled) {
        if (!plan) {
          if (!cancelled && selectOnUp) ui.select([selectOnUp]);
          return;
        }
        void plan.commit(cancelled);
      },
    });
  }

  function planMove(startX: number, startY: number) {
    const doc = currentDoc();
    if (!doc) return null;
    const ids = topLevel(doc, st().selection).filter((id) => !isLockedDeep(doc, id));
    // Nós internos de instâncias, contêineres de slot e a raiz do principal não se movem.
    const block = structureBlock(doc, ids);
    if (block) {
      ui.toast(block);
      return null;
    }
    const nodes = ids.map((id) => getNode(doc, id)!).filter(Boolean);
    const free = nodes.filter((n) => isFreelyPositioned(doc, n));
    if (free.length > 0) {
      const items = free.map((node) => ({
        node,
        root: isRoot(doc, node.id),
        ...nodeXY(doc, node),
      }));
      let dx = 0;
      let dy = 0;
      let shown: Record<string, NodePreview> = {};
      return {
        update(ev: PointerEvent): void {
          const z = st().viewport.z;
          dx = (ev.clientX - startX) / z;
          dy = (ev.clientY - startY) / z;
          if (ev.shiftKey) {
            if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          dx = Math.round(dx);
          dy = Math.round(dy);
          const preview: Record<string, { position?: Point; style?: Record<string, string> }> = {};
          for (const it of items) {
            const x = it.x + dx;
            const y = it.y + dy;
            preview[it.node.id] = it.root
              ? { position: { x, y } }
              : { style: { left: px(x), top: px(y) } };
          }
          shown = preview;
          ui.setPreview(preview);
        },
        async commit(cancelled: boolean): Promise<void> {
          if (cancelled || (dx === 0 && dy === 0)) return ui.releasePreview(shown);
          const cur = currentDoc();
          const ops: Op[] = [];
          for (const it of items) {
            const node = cur ? getNode(cur, it.node.id) : undefined;
            if (cur && node) ops.push(...buildPositionOps(cur, node, it.x + dx, it.y + dy));
          }
          await daemon.applySafe(ops);
          ui.releasePreview(shown);
        },
      };
    }
    // Filhos em fluxo: reordenar dentro do mesmo pai.
    if (
      nodes.length === 0 ||
      !haveSameParent(
        doc,
        nodes.map((n) => n.id),
      )
    )
      return null;
    const parent = getParent(doc, nodes[0]!.id);
    if (!parent) return null;
    // Pai grid: o arrasto escolhe a célula (grid-column/grid-row) em vez de reordenar.
    if (isGridContainer(parent.style)) return planGridMove(root, parent, nodes);
    const axis = flowAxis(parent);
    const siblings = siblingWorldRects(root, parent);
    const movingReal = nodes.map((n) => getEntry(doc, n.id)!.index);
    const ghost: Record<string, { style: Record<string, string> }> = {};
    for (const n of nodes) ghost[n.id] = { style: { opacity: '0.45' } };
    let moveIndex = movingReal[0]!;
    return {
      update(ev: PointerEvent): void {
        const r = resolveFlowInsert(siblings, toWorld(ev), axis, movingReal);
        moveIndex = r.moveIndex;
        useFx.setState({ insert: r.line });
        ui.setPreview(ghost);
      },
      async commit(cancelled: boolean): Promise<void> {
        clearFx();
        if (cancelled || isNoopReorder(movingReal, moveIndex)) return ui.releasePreview(ghost);
        await daemon.applySafe([
          {
            type: 'moveNodes',
            nodeIds: nodes.map((n) => n.id),
            parentId: parent.id,
            index: moveIndex,
          },
        ]);
        ui.releasePreview(ghost);
      },
    };
  }

  /** Redimensiona a caixa da seleção pelas alças (1 ou vários nós). */
  function startResize(e: PointerEvent, handle: HandleName): void {
    const doc = currentDoc();
    if (!doc) return;
    const ids = topLevel(doc, st().selection).filter((id) => !isLockedDeep(doc, id));
    interface Item {
      node: Node;
      rect: Rect;
      free: boolean;
      root: boolean;
      xy: Point;
      /** Soma de padding + borda por eixo (para `content-box`). */
      extraW: number;
      extraH: number;
    }
    const items: Item[] = [];
    for (const id of ids) {
      const node = getNode(doc, id)!;
      const rect = measureWorldRect(root, id);
      if (!rect) continue;
      const el = findNodeEl(root, id);
      let extraW = 0;
      let extraH = 0;
      if (el) {
        const cs = getComputedStyle(el);
        if (cs.boxSizing === 'content-box') {
          const f = (v: string): number => parseFloat(v) || 0;
          extraW =
            f(cs.paddingLeft) + f(cs.paddingRight) + f(cs.borderLeftWidth) + f(cs.borderRightWidth);
          extraH =
            f(cs.paddingTop) + f(cs.paddingBottom) + f(cs.borderTopWidth) + f(cs.borderBottomWidth);
        }
      }
      items.push({
        node,
        rect,
        free: isFreelyPositioned(doc, node),
        root: isRoot(doc, id),
        xy: isFreelyPositioned(doc, node) ? nodeXY(doc, node) : { x: 0, y: 0 },
        extraW,
        extraH,
      });
    }
    const box = unionRects(items.map((i) => i.rect));
    if (!box) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let result: { id: string; set: Record<string, string>; pos: Point | null }[] = [];
    let moved = false;
    let shown: Record<string, NodePreview> = {};

    begin({
      move(ev) {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 1) return;
        moved = true;
        const z = st().viewport.z;
        const next = resizeRect(box, handle, (ev.clientX - startX) / z, (ev.clientY - startY) / z, {
          keepRatio: ev.shiftKey,
          fromCenter: ev.altKey,
        });
        result = [];
        const preview: Record<string, { position?: Point; style?: Record<string, string> }> = {};
        for (const it of items) {
          const nr = items.length === 1 ? next : scaleRectToBox(it.rect, box, next);
          const set: Record<string, string> = {};
          if (Math.round(nr.w) !== Math.round(it.rect.w))
            set.width = px(Math.max(1, nr.w - it.extraW));
          if (Math.round(nr.h) !== Math.round(it.rect.h))
            set.height = px(Math.max(1, nr.h - it.extraH));
          let pos: Point | null = null;
          if (
            it.free &&
            (Math.abs(nr.x - it.rect.x) > 0.001 || Math.abs(nr.y - it.rect.y) > 0.001)
          ) {
            pos = {
              x: Math.round(it.xy.x + nr.x - it.rect.x),
              y: Math.round(it.xy.y + nr.y - it.rect.y),
            };
          }
          result.push({ id: it.node.id, set, pos });
          const style = { ...set };
          if (pos && !it.root) {
            style.left = px(pos.x);
            style.top = px(pos.y);
          }
          preview[it.node.id] = {
            ...(Object.keys(style).length ? { style } : {}),
            ...(pos && it.root ? { position: pos } : {}),
          };
        }
        shown = preview;
        ui.setPreview(preview);
      },
      async up(_e, cancelled) {
        if (cancelled || !moved) return ui.releasePreview(shown);
        const cur = currentDoc();
        const ops: Op[] = [];
        const changes = result.filter(
          (r) => Object.keys(r.set).length && cur && getNode(cur, r.id),
        );
        if (changes.length) {
          ops.push({
            type: 'updateStyles',
            changes: changes.map((r) => ({ nodeId: r.id, set: r.set })),
          });
        }
        for (const r of result) {
          const node = cur ? getNode(cur, r.id) : undefined;
          if (cur && node && r.pos) ops.push(...buildPositionOps(cur, node, r.pos.x, r.pos.y));
        }
        if (ops.length) await daemon.applySafe(ops);
        ui.releasePreview(shown);
      },
    });
  }

  /** Ferramentas de criação: frame, rect, text, image. */
  function startCreate(
    e: PointerEvent,
    tool: 'frame' | 'rect' | 'text' | 'image' | ShapeTool,
  ): void {
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = toWorld(e);
    let dragged = false;
    begin({
      move(ev) {
        if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD)
          return;
        dragged = true;
        if (tool !== 'text')
          useFx.setState({ draw: shapeDragRect(tool, startW, toWorld(ev), ev.shiftKey) });
      },
      up(ev, cancelled) {
        clearFx();
        if (cancelled || !ev) return;
        const rect =
          dragged && tool !== 'text' ? shapeDragRect(tool, startW, toWorld(ev), ev.shiftKey) : null;
        if (isShapeTool(tool)) {
          void createShape(tool, startW, { x: startX, y: startY }, rect, { star: ev.altKey });
          return;
        }
        void finishCreate(tool, startW, { x: startX, y: startY }, rect);
      },
    });
  }

  async function finishCreate(
    tool: 'frame' | 'rect' | 'text' | 'image',
    startW: Point,
    client: Point,
    rect: Rect | null,
  ): Promise<void> {
    const doc = currentDoc();
    const pageId = currentPageId();
    if (!doc || !pageId) return;
    const at = rect ? { x: rect.x, y: rect.y } : startW;
    const size = rect ? { w: Math.max(1, rect.w), h: Math.max(1, rect.h) } : null;

    if (tool === 'image') {
      if (st().tool === tool) ui.setTool('select');
      const file = await pickImageFile();
      if (file) await insertImageFile(file, at, size ?? undefined);
      return;
    }

    let node: Node;
    let ops: Op[];
    // Modo de edição do principal: só se cria dentro do principal.
    if (
      pageId === COMPONENT_EDIT_PAGE_ID &&
      (tool === 'frame' || !planPlacement(doc, at, client).parentId)
    ) {
      if (st().tool === tool) ui.setTool('select');
      ui.toast('No modo de edição do componente, desenhe dentro do principal');
      return;
    }
    if (tool === 'frame') {
      node = size ? makeFrame(at.x, at.y, size.w, size.h) : makeFrame(at.x, at.y);
      ops = [{ type: 'createNode', pageId, node }];
    } else {
      const plan = planPlacement(doc, at, client);
      if (tool === 'rect') {
        if (!plan.parentId) {
          node = size
            ? makeFrame(at.x, at.y, size.w, size.h, 'Container')
            : makeFrame(at.x, at.y, 120, 120, 'Container');
        } else {
          node = makeContainer({ ...(size ?? {}), x: plan.x, y: plan.y, absolute: !plan.flow });
        }
      } else {
        if (!plan.parentId) {
          ui.toast('Clique dentro de um frame para criar o texto', 'info');
          return;
        }
        node = makeText({ x: plan.x, y: plan.y, absolute: !plan.flow });
      }
      ops = buildCreateOps(pageId, plan, node);
    }
    // Volta para seleção já (antes do ack), para não sobrescrever uma ferramenta escolhida no meio.
    if (st().tool === tool) ui.setTool('select');
    const ack = await daemon.applySafe(ops);
    if (!ack) return;
    ui.select([node.id]);
    if (tool === 'text') ui.editText(node.id);
  }

  /* ------------------------------ ponteiro ------------------------------ */

  const nodeIdOf = (target: Element): { id: string | null; label: boolean } => {
    const label = target.closest('[data-frame-label]')?.getAttribute('data-frame-label');
    if (label) return { id: label, label: true };
    return {
      id: target.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null,
      label: false,
    };
  };

  function onPointerDown(e: PointerEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-testid="text-editor"]')) return;
    if (st().cropNodeId) {
      // Modo de recorte: a interface de recorte cuida dos próprios gestos; clicar fora confirma.
      if (target.closest('[data-crop-ui]')) return;
      e.preventDefault();
      void commitCrop();
      return;
    }
    // Alças de span do grid têm gesto próprio (canvas/gridDrag.ts).
    if (target.closest('[data-grid-span]')) return;
    // Edição de pontos: o overlay trata o que é dele; clicar fora sai do modo e segue normalmente.
    if (st().editingVectorId) {
      if (target.closest('[data-vector-overlay]')) return;
      ui.editVector(null);
    }
    // O que estava focado (inputs de propriedades, texto em edição) perde o foco ao clicar no canvas.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    if (e.button === 1 || (e.button === 0 && panMode())) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle');
    if (handle) {
      e.preventDefault();
      startResize(e, handle as HandleName);
      return;
    }
    const tool = st().tool;
    if (
      tool === 'frame' ||
      tool === 'rect' ||
      tool === 'text' ||
      tool === 'image' ||
      isShapeTool(tool)
    ) {
      e.preventDefault();
      startCreate(e, tool);
      return;
    }
    if (tool === 'pen') {
      e.preventDefault();
      penPointerDown(e, root);
      return;
    }
    const doc = currentDoc();
    if (!doc) return;
    const sel = st().selection;
    const { id, label } = nodeIdOf(target);
    let resolved: string | null = null;
    if (id && getEntry(doc, id)) {
      resolved = label
        ? getNode(doc, id)!.locked
          ? null
          : id
        : resolveClickTarget(doc, id, sel, { deep: e.ctrlKey || e.metaKey });
    }
    if (resolved === COMPONENT_FRAME_ID) resolved = null;
    if (!resolved) {
      startMarquee(e);
      return;
    }
    if (e.shiftKey) {
      ui.toggle(resolved);
      return;
    }
    let selectOnUp: string | null = null;
    if (sel.includes(resolved)) {
      if (sel.length > 1) selectOnUp = resolved;
    } else {
      ui.select([resolved]);
    }
    startMove(e, selectOnUp);
  }

  function onPointerMove(e: PointerEvent): void {
    if (st().tool === 'pen') return penPointerMove(e, root);
    if (active || st().tool !== 'select') {
      if (!active && st().hoverId) ui.hover(null);
      return;
    }
    const target = e.target;
    const doc = currentDoc();
    if (!(target instanceof Element) || !doc) return;
    const { id, label } = nodeIdOf(target);
    if (!id || !getEntry(doc, id)) return ui.hover(null);
    if (label) return ui.hover(getNode(doc, id)!.locked || id === COMPONENT_FRAME_ID ? null : id);
    // Mesma regra do clique: Ctrl/Cmd = seleção profunda (Alt só liga a régua de distâncias).
    const hovered = resolveClickTarget(doc, id, st().selection, { deep: e.ctrlKey || e.metaKey });
    ui.hover(hovered === COMPONENT_FRAME_ID ? null : hovered);
  }

  function onPointerLeave(): void {
    if (!active) ui.hover(null);
  }

  function onDoubleClick(e: MouseEvent): void {
    const target = e.target;
    const doc = currentDoc();
    if (st().tool === 'pen') return penDoubleClick();
    if (!(target instanceof Element) || !doc || st().tool !== 'select') return;
    if (target.closest('[data-testid="text-editor"]')) return;
    const { id, label } = nodeIdOf(target);
    if (!id || label || !getEntry(doc, id)) return;
    if (st().cropNodeId) return;
    const r = resolveDoubleClick(doc, id, st().selection);
    if (r.select) ui.select([r.select]);
    if (r.edit) ui.editText(r.edit);
    // Imagem já selecionada: duplo clique entra no recorte visual.
    const sel = st().selection;
    if (
      !r.select &&
      !r.edit &&
      sel.length === 1 &&
      sel[0] === id &&
      getNode(doc, id)?.type === 'image'
    ) {
      startCrop(id);
    }
    // Duplo clique num svg já selecionado entra na edição de pontos.
    const only = st().selection;
    if (
      !r.select &&
      !r.edit &&
      only.length === 1 &&
      only[0] === id &&
      getNode(doc, id)?.type === 'svg'
    )
      ui.editVector(id);
  }

  function onContextMenu(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element) || target.closest('[data-testid="text-editor"]')) return;
    e.preventDefault();
    const doc = currentDoc();
    if (!doc) return;
    const { id } = nodeIdOf(target);
    if (!id || !getEntry(doc, id)) return;
    const sel = st().selection;
    const resolved = resolveClickTarget(doc, id, sel, { deep: e.ctrlKey || e.metaKey });
    if (!resolved || resolved === COMPONENT_FRAME_ID) return;
    if (!sel.includes(resolved)) ui.select([resolved]);
    openContextMenu(e.clientX, e.clientY, buildNodeMenu());
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= root.clientWidth;
      dy *= root.clientHeight;
    }
    if (e.ctrlKey || e.metaKey) {
      const rr = root.getBoundingClientRect();
      const factor = Math.exp(-Math.max(-40, Math.min(40, dy)) * 0.01);
      ui.setViewport((v) => zoomAtPoint(v, v.z * factor, e.clientX - rr.left, e.clientY - rr.top));
    } else if (e.shiftKey) {
      const d = dx || dy;
      ui.setViewport((v) => ({ ...v, x: v.x - d }));
    } else {
      ui.setViewport((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
    }
  }

  /** Nada dentro do design navega, foca ou envia: bloqueia o comportamento padrão. */
  function blockDefault(e: Event): void {
    if (e.target instanceof Element && e.target.closest('[data-testid="text-editor"]')) return;
    e.preventDefault();
  }

  function onDragOver(e: DragEvent): void {
    if (e.dataTransfer?.types.includes(COMPONENT_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDrop(e: DragEvent): void {
    // Componente arrastado da aba Componentes: instância no ponto solto.
    const comp = e.dataTransfer ? readComponentDrag(e.dataTransfer) : null;
    if (comp) {
      e.preventDefault();
      void insertInstance(comp.componentId, {
        ...(comp.kit ? { kit: comp.kit } : {}),
        drop: { world: toWorld(e), client: { x: e.clientX, y: e.clientY } },
      });
      return;
    }
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    const at = toWorld(e);
    void (async () => {
      let offset = 0;
      for (const file of files) {
        await insertImageFile(file, { x: at.x + offset, y: at.y + offset });
        offset += 24;
      }
    })();
  }

  /* ------------------------------ teclado local ------------------------------ */

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Alt' && !st().altDown) useUi.setState({ altDown: true });
    if (e.code === 'Space' && !isTypingTarget(e.target)) {
      if (!localSpace) {
        localSpace = true;
        syncCursor();
      }
      e.preventDefault();
    }
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Alt' && st().altDown) useUi.setState({ altDown: false });
    if (e.code === 'Space' && localSpace) {
      localSpace = false;
      syncCursor();
    }
  }
  function onBlur(): void {
    if (st().altDown) useUi.setState({ altDown: false });
    if (localSpace) {
      localSpace = false;
      syncCursor();
    }
  }

  const noPassive = { passive: false } as const;
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerleave', onPointerLeave);
  root.addEventListener('dblclick', onDoubleClick);
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('wheel', onWheel, noPassive);
  root.addEventListener('mousedown', blockDefault);
  root.addEventListener('click', blockDefault, true);
  root.addEventListener('auxclick', blockDefault);
  root.addEventListener('submit', blockDefault);
  root.addEventListener('dragstart', blockDefault);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return () => {
    active?.stop();
    offUi();
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerleave', onPointerLeave);
    root.removeEventListener('dblclick', onDoubleClick);
    root.removeEventListener('contextmenu', onContextMenu);
    root.removeEventListener('wheel', onWheel);
    root.removeEventListener('mousedown', blockDefault);
    root.removeEventListener('click', blockDefault, true);
    root.removeEventListener('auxclick', blockDefault);
    root.removeEventListener('submit', blockDefault);
    root.removeEventListener('dragstart', blockDefault);
    root.removeEventListener('dragover', onDragOver);
    root.removeEventListener('drop', onDrop);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
