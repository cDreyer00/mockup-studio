// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeAnimation } from '@mockup/core';
import { fxClock, useFxClock } from '../fx/clock';
import { MotionScope } from './scope';

/** Minimal Web Animations double: records what the scope writes. */
class FakeAnimation {
  currentTime: number | null = 0;
  private _start: number | null = null;
  paused = false;
  cancelled = false;
  constructor(
    public target: Element,
    public keyframes: Keyframe[],
    public options: KeyframeAnimationOptions,
  ) {}
  get startTime(): number | null {
    return this._start;
  }
  set startTime(v: number | null) {
    this._start = v;
    this.paused = false;
  }
  play(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
    this._start = null;
  }
  cancel(): void {
    this.cancelled = true;
  }
  persist(): void {}
}

let created: FakeAnimation[] = [];
let now = 1000;

beforeEach(() => {
  created = [];
  now = 1000;
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (
    this: Element,
    k: Keyframe[],
    o: KeyframeAnimationOptions,
  ) {
    const a = new FakeAnimation(this, k, o);
    created.push(a);
    return a;
  };
  Object.defineProperty(document, 'timeline', {
    configurable: true,
    value: {
      get currentTime() {
        return now;
      },
    },
  });
  useFxClock.setState({ playing: true, manual: null });
});

afterEach(() => {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  vi.restoreAllMocks();
});

const node = (id: string, animations: NodeAnimation[], children: Node[] = []): Node => ({
  id,
  type: 'element',
  name: id,
  tag: 'div',
  attrs: {},
  style: {},
  children,
  locked: false,
  hidden: false,
  animations,
});

function mount(frame: Node, nodes: Node[], scope: MotionScope): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  const make = (n: Node, parent: HTMLElement | null): void => {
    const el = document.createElement('div');
    el.dataset.nodeId = n.id;
    parent?.appendChild(el);
    els.set(n.id, el);
    n.children.forEach((c) => make(c, el));
  };
  make(frame, null);
  document.body.appendChild(els.get(frame.id)!);
  // children attach first, then the root frame (React layout effect order)
  for (const n of nodes) scope.attach(frame.id, n, els.get(n.id)!);
  scope.setFrame(frame.id, frame, els.get(frame.id)!);
  return els;
}

const live = () => created.filter((a) => !a.cancelled);

describe('MotionScope', () => {
  const title = node('tx_title', [{ kind: 'in', preset: 'fade-up' }]);
  const badge = node('el_badge', [
    { kind: 'in', preset: 'pop', build: 1 },
    { kind: 'emphasis', preset: 'float', delay: 200 },
  ]);
  const frame: Node = { ...node('fr_one', []), type: 'frame', children: [title, badge] };

  it('rest: only infinite loops exist, synced to the effects clock', () => {
    const scope = new MotionScope({ loopsInRest: true });
    mount(frame, [title, badge], scope);
    expect(live()).toHaveLength(1);
    const loop = live()[0]!;
    expect(loop.options.iterations).toBe(Infinity);
    expect(loop.paused).toBe(false);
    expect(loop.startTime).not.toBeNull();
    fxClock.setPlaying(false);
    expect(loop.paused).toBe(true);
    scope.dispose();
  });

  it('render scope without loops in rest creates nothing', () => {
    const scope = new MotionScope();
    mount(frame, [title, badge], scope);
    expect(live()).toHaveLength(0);
    scope.dispose();
  });

  it('seek positions every build on the linear timeline', () => {
    const scope = new MotionScope();
    mount(frame, [title, badge], scope);
    scope.setMode(frame.id, { type: 'seek', at: { time: 300 } });
    const byId = (id: string) =>
      live().filter((a) => (a.target as HTMLElement).dataset.nodeId === id);
    const fadeUp = byId('tx_title')[0];
    const pop = byId('el_badge').find((a) => a.options.iterations !== Infinity);
    const float = byId('el_badge').find((a) => a.options.iterations === Infinity);
    expect(fadeUp!.paused).toBe(true);
    expect(fadeUp!.currentTime).toBe(300);
    // build 1 starts when build 0 ends (fade-up 600 ms; the float loop does not count)
    expect(pop!.currentTime).toBe(0);
    expect(float!.currentTime).toBe(300);
    scope.setMode(frame.id, { type: 'seek', at: { time: 900 } });
    expect(pop!.currentTime).toBe(300);
    scope.dispose();
  });

  it('play aligns each build start on one origin', () => {
    const scope = new MotionScope();
    mount(frame, [title, badge], scope);
    now = 5000;
    scope.setMode(frame.id, { type: 'play', from: 100 });
    const byId = (id: string) =>
      live().filter((a) => (a.target as HTMLElement).dataset.nodeId === id);
    expect(byId('tx_title')[0]!.startTime).toBe(4900);
    const pop = byId('el_badge').find((a) => a.options.iterations !== Infinity)!;
    expect(pop.startTime).toBe(4900 + 600);
    now = 5400;
    expect(scope.linearTime(frame.id)).toBe(500);
    scope.dispose();
  });

  it('builds: the next click starts only its build; going back resets it', () => {
    const scope = new MotionScope();
    mount(frame, [title, badge], scope);
    now = 2000;
    scope.setMode(frame.id, { type: 'builds', clicks: 0, animate: true });
    const byId = (id: string) =>
      live().filter((a) => (a.target as HTMLElement).dataset.nodeId === id);
    const fadeUp = byId('tx_title')[0]!;
    const pop = byId('el_badge').find((a) => a.options.iterations !== Infinity)!;
    expect(fadeUp.startTime).toBe(2000);
    expect(pop.paused).toBe(true);
    expect(pop.currentTime).toBe(0);
    now = 3000;
    scope.setMode(frame.id, { type: 'builds', clicks: 1, animate: true });
    expect(fadeUp.startTime).toBe(2000);
    expect(pop.startTime).toBe(3000);
    scope.setMode(frame.id, { type: 'builds', clicks: 0, animate: false });
    expect(pop.paused).toBe(true);
    expect(fadeUp.startTime).toBe(2000);
    scope.dispose();
  });

  it('split children: one animation per visible child, staggered', () => {
    const kids = ['a', 'b', 'c'].map((k) => node(`el_${k}`, []));
    const list = node(
      'el_list',
      [{ kind: 'in', preset: 'fade', split: 'children', stagger: 50 }],
      kids,
    );
    const f: Node = { ...node('fr_two', []), type: 'frame', children: [list] };
    const scope = new MotionScope();
    mount(f, [list], scope);
    scope.setMode(f.id, { type: 'seek', at: { time: 0 } });
    expect(live().map((a) => (a.target as HTMLElement).dataset.nodeId)).toEqual([
      'el_a',
      'el_b',
      'el_c',
    ]);
    expect(live().map((a) => a.options.delay)).toEqual([0, 50, 100]);
    expect(live().map((a) => a.options.fill)).toEqual(['backwards', 'backwards', 'backwards']);
    scope.dispose();
  });

  it('text segments: only its own, not those of a descendant with its own split', () => {
    const inner = { ...node('tx_inner', [{ kind: 'in', preset: 'fade', split: 'chars' }]) };
    const text: Node = {
      ...node('tx_outer', [{ kind: 'in', preset: 'fade', split: 'words' }], [inner]),
      type: 'text',
      text: 'one two',
    };
    const f: Node = { ...node('fr_seg', []), type: 'frame', children: [text] };
    const els = mount(f, [], new MotionScope());
    // DOM as the renderer leaves it: the descendant's segments come first
    const outerEl = els.get('tx_outer')!;
    const innerEl = els.get('tx_inner')!;
    for (const ch of 'ab') {
      const seg = document.createElement('span');
      seg.dataset.motionSeg = 'c';
      seg.textContent = ch;
      innerEl.appendChild(seg);
    }
    for (const w of ['one', 'two']) {
      const seg = document.createElement('span');
      seg.dataset.motionSeg = 'w';
      seg.textContent = w;
      outerEl.appendChild(seg);
    }
    const scope = new MotionScope();
    scope.attach(f.id, text, outerEl);
    scope.setFrame(f.id, f, els.get(f.id)!);
    scope.setMode(f.id, { type: 'seek', at: { time: 0 } });
    expect(live().map((a) => a.target.textContent)).toEqual(['one', 'two']);
    scope.dispose();
  });

  it('media nodes of repeater clones resolve to their own element', () => {
    const anim: NodeAnimation[] = [{ kind: 'in', preset: 'fade' }];
    // a template media node and two clones, found by data-node-id (media views give no element)
    const ids = ['vd_x', 'vd_x~1', 'vd_x~2'];
    const vids = ids.map((id) => ({ ...node(id, anim), type: 'video' as const }));
    const f: Node = { ...node('fr_rep', []), type: 'frame', children: vids };
    const scope = new MotionScope();
    const els = mount(f, [], scope);
    for (const v of vids) scope.attach(f.id, v, null);
    scope.setMode(f.id, { type: 'seek', at: { time: 0 } });
    expect(live().map((a) => a.target)).toEqual(ids.map((id) => els.get(id)));
    scope.dispose();
  });

  it('back to rest cancels the preview animations and recreates the loops', () => {
    const scope = new MotionScope({ loopsInRest: true });
    mount(frame, [title, badge], scope);
    scope.setMode(frame.id, { type: 'seek', at: { time: 0 } });
    expect(live()).toHaveLength(3);
    scope.setMode(frame.id, { type: 'rest' });
    expect(live()).toHaveLength(1);
    expect(live()[0]!.options.iterations).toBe(Infinity);
    scope.dispose();
    expect(live()).toHaveLength(0);
  });
});

/** Registers an existing DOM tree; returns the cleanups in React's order (children, then frame). */
function register(
  scope: MotionScope,
  frame: Node,
  nodes: Node[],
  els: Map<string, HTMLElement>,
): () => void {
  const undo = nodes.map((n) => scope.attach(frame.id, n, els.get(n.id)!));
  undo.push(scope.setFrame(frame.id, frame, els.get(frame.id)!));
  return () => undo.forEach((u) => u());
}

function dom(frame: Node): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  const make = (n: Node, parent: HTMLElement | null): void => {
    const el = document.createElement('div');
    el.dataset.nodeId = n.id;
    parent?.appendChild(el);
    els.set(n.id, el);
    n.children.forEach((c) => make(c, el));
  };
  make(frame, null);
  document.body.appendChild(els.get(frame.id)!);
  return els;
}

const loopNode = node('el_loop', [{ kind: 'emphasis', preset: 'float' }]);
const clickNode = node('el_click', [{ kind: 'in', preset: 'fade', build: 1 }]);
const lifeFrame: Node = {
  ...node('fr_life', []),
  type: 'frame',
  children: [loopNode, clickNode],
};

describe('MotionScope: document changes while a frame is not at rest', () => {
  // A new document gives new node objects: React runs every cleanup before the new effects.
  const recommit = (scope: MotionScope, undo: () => void, els: Map<string, HTMLElement>) => {
    const next = structuredClone(lifeFrame);
    undo();
    return register(scope, next, next.children, els);
  };

  it('keeps a seek: the new animations are paused at the same instant', async () => {
    const scope = new MotionScope();
    const els = dom(lifeFrame);
    const undo = register(scope, lifeFrame, lifeFrame.children, els);
    scope.setMode(lifeFrame.id, { type: 'seek', at: { time: 0 } });
    recommit(scope, undo, els);
    await Promise.resolve();
    expect(scope.getMode(lifeFrame.id)).toEqual({ type: 'seek', at: { time: 0 } });
    expect(live()).toHaveLength(2);
    expect(live().map((a) => [a.paused, a.currentTime])).toEqual([
      [true, 0],
      [true, 0],
    ]);
    expect(scope.liveCount()).toBe(2);
    scope.dispose();
  });

  it('keeps the presentation builds: a click build not played stays unplayed', async () => {
    const scope = new MotionScope();
    const els = dom(lifeFrame);
    const undo = register(scope, lifeFrame, lifeFrame.children, els);
    now = 2000;
    scope.setMode(lifeFrame.id, { type: 'builds', clicks: 0, animate: true });
    now = 2500;
    recommit(scope, undo, els);
    await Promise.resolve();
    expect(scope.getMode(lifeFrame.id).type).toBe('builds');
    const click = live().find((a) => (a.target as HTMLElement).dataset.nodeId === 'el_click')!;
    expect([click.paused, click.currentTime]).toEqual([true, 0]);
    const loop = live().find((a) => (a.target as HTMLElement).dataset.nodeId === 'el_loop')!;
    // build 0 keeps the start it had before the edit
    expect(loop.startTime).toBe(2000);
    scope.dispose();
  });

  it('keeps a play on its origin', async () => {
    const scope = new MotionScope();
    const els = dom(lifeFrame);
    const undo = register(scope, lifeFrame, lifeFrame.children, els);
    now = 4000;
    scope.setMode(lifeFrame.id, { type: 'play', from: 0 });
    now = 4200;
    recommit(scope, undo, els);
    await Promise.resolve();
    expect(scope.linearTime(lifeFrame.id)).toBe(200);
    scope.dispose();
  });
});
