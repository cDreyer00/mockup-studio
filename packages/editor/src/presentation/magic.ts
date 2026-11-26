/**
 * Magic move: layers with the same name on two consecutive slides morph from their old rect to the
 * new one (FLIP) while crossfading from the old look to the new one. The rest of the slides
 * crossfades with the transition plan.
 *
 * The ghosts live in an overlay above both slots (so they are not faded with the incoming slot),
 * inside a shallow copy of the incoming slide's world (tokens and base CSS still apply), positioned
 * in that slide's unscaled coordinates. The real matched elements are hidden while the ghosts run
 * and revealed exactly when the ghosts are removed.
 */
import type { Node } from '@mockup/core';
import { fitSlide } from './fit';
import type { Size } from './fit';

export interface MagicPair {
  name: string;
  /** Node id on the outgoing slide. */
  outId: string;
  /** Node id on the incoming slide. */
  inId: string;
}

interface Indexed {
  byName: Map<string, Node[]>;
  /** Ancestor ids (root frame excluded) of every node. */
  ancestors: Map<string, string[]>;
  order: Map<string, number>;
}

function index(frame: Node): Indexed {
  const byName = new Map<string, Node[]>();
  const ancestors = new Map<string, string[]>();
  const order = new Map<string, number>();
  let n = 0;
  const visit = (node: Node, chain: string[], root: boolean): void => {
    if (node.hidden) return;
    if (!root) {
      order.set(node.id, n++);
      ancestors.set(node.id, chain);
      const name = node.name?.trim();
      if (name) {
        const list = byName.get(name);
        if (list) list.push(node);
        else byName.set(name, [node]);
      }
    }
    const next = root ? chain : [...chain, node.id];
    for (const c of node.children) visit(c, next, false);
  };
  visit(frame, [], true);
  return { byName, ancestors, order };
}

/**
 * Layers to morph: names that are unique on both slides (root frames excluded, hidden layers
 * ignored), keeping only the top-most match (a layer inside an already matched layer is skipped,
 * on either slide). Layers that appear on a click on the incoming slide are not matched.
 */
export function magicPairs(outgoing: Node, incoming: Node): MagicPair[] {
  const a = index(outgoing);
  const b = index(incoming);
  const candidates: { pair: MagicPair; in: Node }[] = [];
  for (const [name, ins] of b.byName) {
    const outs = a.byName.get(name);
    if (ins.length !== 1 || !outs || outs.length !== 1) continue;
    const inNode = ins[0]!;
    if (inNode.animations?.some((x) => (x.build ?? 0) > 0)) continue;
    candidates.push({ pair: { name, outId: outs[0]!.id, inId: inNode.id }, in: inNode });
  }
  // Outer layers first (document order on the incoming slide).
  candidates.sort((x, y) => b.order.get(x.in.id)! - b.order.get(y.in.id)!);
  const accepted: MagicPair[] = [];
  for (const { pair } of candidates) {
    const inChain = b.ancestors.get(pair.inId) ?? [];
    const outChain = a.ancestors.get(pair.outId) ?? [];
    const nested = accepted.some(
      (p) =>
        inChain.includes(p.inId) ||
        outChain.includes(p.outId) ||
        (b.ancestors.get(p.inId) ?? []).includes(pair.inId) ||
        (a.ancestors.get(p.outId) ?? []).includes(pair.outId),
    );
    if (!nested) accepted.push(pair);
  }
  return accepted;
}

/** Inherited text properties copied onto each ghost root (it is no longer inside its parents). */
const INHERITED = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'font-feature-settings',
  'color',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-transform',
  'text-indent',
  'white-space',
  'direction',
];

export interface MagicRun {
  /** Ghost animations (the caller waits for them). */
  animations: Animation[];
  /** Removes the ghosts and reveals the real elements. */
  cleanup(): void;
}

export interface MagicOptions {
  stage: HTMLElement;
  stageSize: Size;
  incomingSlot: HTMLElement;
  outgoingSlot: HTMLElement;
  incomingFrameId: string;
  outgoingFrameId: string;
  pairs: MagicPair[];
  duration: number;
  /** CSS easing. */
  easing: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const byId = (root: Element, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-node-id="${id.replace(/["\\]/g, '\\$&')}"]`);

function makeGhost(el: HTMLElement, box: Box): HTMLElement {
  const cs = getComputedStyle(el);
  const g = el.cloneNode(true) as HTMLElement;
  g.removeAttribute('data-node-id');
  g.removeAttribute('id');
  for (const d of g.querySelectorAll('[data-node-id],[id]')) {
    d.removeAttribute('data-node-id');
    d.removeAttribute('id');
  }
  for (const p of INHERITED) g.style.setProperty(p, cs.getPropertyValue(p));
  const set: Record<string, string> = {
    position: 'absolute',
    margin: '0',
    left: `${box.x}px`,
    top: `${box.y}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${box.w}px`,
    height: `${box.h}px`,
    'min-width': '0',
    'min-height': '0',
    'max-width': 'none',
    'max-height': 'none',
    'box-sizing': 'border-box',
    'transform-origin': '0 0',
    transform: 'none',
    translate: 'none',
    rotate: 'none',
    scale: 'none',
    opacity: '1',
    visibility: 'visible',
    animation: 'none',
    'pointer-events': 'none',
  };
  for (const [k, v] of Object.entries(set)) g.style.setProperty(k, v);
  return g;
}

/**
 * Builds the ghosts and starts their animations. Returns `null` (nothing touched) when nothing
 * can be measured or Web Animations are not available: the caller falls back to the crossfade.
 */
export function startMagic(o: MagicOptions): MagicRun | null {
  if (typeof o.stage.animate !== 'function') return null;
  const inFrame = byId(o.incomingSlot, o.incomingFrameId);
  const outFrame = byId(o.outgoingSlot, o.outgoingFrameId);
  const world = inFrame?.parentElement;
  const slideEl = o.incomingSlot.querySelector<HTMLElement>('.pres-slide');
  if (!inFrame || !outFrame || !world || !slideEl) return null;
  const inSize = { w: inFrame.offsetWidth, h: inFrame.offsetHeight };
  if (inSize.w <= 0 || inSize.h <= 0) return null;
  const fit = fitSlide(inSize, o.stageSize);
  const stageRect = o.stage.getBoundingClientRect();
  const frameRect = inFrame.getBoundingClientRect();
  // Current (pre-fit) scale of the incoming slide on screen, whatever transform its slot has.
  const kNow = frameRect.width > 0 ? frameRect.width / inSize.w : 1;

  interface Item {
    oldEl: HTMLElement;
    newEl: HTMLElement;
    from: Box;
    to: Box;
  }
  const items: Item[] = [];
  for (const pair of o.pairs) {
    const oldEl = byId(o.outgoingSlot, pair.outId);
    const newEl = byId(o.incomingSlot, pair.inId);
    if (!oldEl || !newEl) continue;
    const r0 = oldEl.getBoundingClientRect();
    const r1 = newEl.getBoundingClientRect();
    const from: Box = {
      x: (r0.left - stageRect.left - fit.x) / fit.scale,
      y: (r0.top - stageRect.top - fit.y) / fit.scale,
      w: r0.width / fit.scale,
      h: r0.height / fit.scale,
    };
    const to: Box = {
      x: (r1.left - frameRect.left) / kNow,
      y: (r1.top - frameRect.top) / kNow,
      w: r1.width / kNow,
      h: r1.height / kNow,
    };
    const vals = [from.x, from.y, from.w, from.h, to.x, to.y, to.w, to.h];
    if (vals.some((v) => !Number.isFinite(v)) || from.w < 0.5 || from.h < 0.5) continue;
    if (to.w < 0.5 || to.h < 0.5) continue;
    items.push({ oldEl, newEl, from, to });
  }
  if (!items.length) return null;

  const layer = document.createElement('div');
  layer.className = 'pres-ghost-slot';
  const ghostSlide = slideEl.cloneNode(false) as HTMLElement;
  ghostSlide.removeAttribute('data-testid');
  ghostSlide.removeAttribute('data-frame-id');
  ghostSlide.removeAttribute('data-scale');
  ghostSlide.style.visibility = 'visible';
  ghostSlide.style.transform = `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`;
  const ghostWorld = world.cloneNode(false) as HTMLElement;
  ghostWorld.removeAttribute('data-testid');
  ghostSlide.append(ghostWorld);
  layer.append(ghostSlide);

  const hidden: { el: HTMLElement; visibility: string }[] = [];
  const animations: Animation[] = [];
  const cleanup = (): void => {
    layer.remove();
    for (const h of hidden) h.el.style.visibility = h.visibility;
    hidden.length = 0;
  };
  try {
    const timing: KeyframeAnimationOptions = {
      duration: o.duration,
      easing: o.easing,
      fill: 'both',
    };
    const tf = (dx: number, dy: number, sx: number, sy: number): string =>
      `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    const ghosts: { el: HTMLElement; kf: Keyframe[] }[] = [];
    for (const { oldEl, newEl, from, to } of items) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const sx = to.w / from.w;
      const sy = to.h / from.h;
      const oldGhost = makeGhost(oldEl, from);
      const newGhost = makeGhost(newEl, to);
      ghostWorld.append(oldGhost, newGhost);
      ghosts.push(
        {
          el: oldGhost,
          kf: [
            { transform: tf(0, 0, 1, 1), opacity: '1' },
            { transform: tf(dx, dy, sx, sy), opacity: '0' },
          ],
        },
        {
          el: newGhost,
          kf: [
            { transform: tf(-dx, -dy, 1 / sx, 1 / sy), opacity: '0' },
            { transform: tf(0, 0, 1, 1), opacity: '1' },
          ],
        },
      );
      for (const el of [oldEl, newEl]) {
        hidden.push({ el, visibility: el.style.visibility });
        el.style.visibility = 'hidden';
      }
    }
    o.stage.append(layer);
    for (const g of ghosts) animations.push(g.el.animate(g.kf, timing));
  } catch {
    for (const a of animations) a.cancel();
    cleanup();
    return null;
  }
  return { animations, cleanup };
}
