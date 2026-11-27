// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createNodeFromTag } from '@mockup/core';
import type { Document, Node, NodeAnimation } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { runEditorCommand } from './editorCommands';
import { magicPairs } from './magic';
import { PresentationView } from './PresentationView';
import { presentation, usePresentation } from './presentationStore';

const anim = (build: number): NodeAnimation => ({ kind: 'in', preset: 'fade-up', build });

function frame(name: string, children: Node[] = [], transition?: Node['slideTransition']): Node {
  const f = createNodeFromTag('div', {
    isRoot: true,
    name,
    styles: { width: '400px', height: '300px' },
    children,
  });
  if (transition) f.slideTransition = transition;
  return f;
}

function layer(name: string, builds: number[] = [], children: Node[] = []): Node {
  const n = createNodeFromTag('div', { name, children });
  if (builds.length) n.animations = builds.map(anim);
  return n;
}

function load(doc: Document): void {
  useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
}

/** Slide 1 has 2 builds, slide 2 none, slide 3 has 1; slide 2 enters with a push. */
function deck(): Document {
  const doc = createDocument('Deck');
  doc.pages[0]!.frames.push(
    frame('One', [layer('a', [1]), layer('b', [2])]),
    frame('Two', [layer('c')], { preset: 'push', direction: 'left', duration: 300 }),
    frame('Three', [layer('d', [1])]),
  );
  return doc;
}

const st = () => usePresentation.getState();

type Animate = unknown;
const proto = HTMLElement.prototype as unknown as { animate?: Animate };
const nativeAnimate = proto.animate;
/** Animation double: happy-dom rejects `finished` when an animation is cancelled. */
function fakeAnimate(): unknown {
  return {
    finished: new Promise(() => undefined),
    cancel() {},
    finish() {},
    pause() {},
    play() {},
    persist() {},
  };
}

beforeEach(() => {
  proto.animate = fakeAnimate;
  useUi.setState({ selection: [], pageId: null, componentEdit: null, editingComponentId: null });
});
afterEach(() => {
  cleanup();
  presentation.stop();
  useDoc.setState({ doc: null, rawDoc: null, activeDocId: null });
  proto.animate = nativeAnimate;
  vi.restoreAllMocks();
});

describe('builds navigation', () => {
  it('reports build and builds', () => {
    load(deck());
    presentation.start();
    expect(presentation.getState()).toMatchObject({ index: 0, build: 0, builds: 2 });
  });

  it('next plays the builds before moving to the next slide (build 0)', () => {
    load(deck());
    presentation.start();
    presentation.navigate({ type: 'next' });
    expect(st()).toMatchObject({ index: 0, build: 1 });
    expect(st().nav.animate).toBe(true);
    presentation.navigate({ type: 'next' });
    expect(st()).toMatchObject({ index: 0, build: 2 });
    presentation.navigate({ type: 'next' });
    expect(st()).toMatchObject({ index: 1, build: 0, builds: 0 });
    expect(st().nav.enter).toBe(true);
  });

  it('previous undoes a build instantly, then lands on the previous slide at its last build', () => {
    load(deck());
    presentation.start();
    for (let i = 0; i < 3; i++) presentation.navigate({ type: 'next' });
    expect(st().index).toBe(1);
    presentation.navigate({ type: 'previous' });
    expect(st()).toMatchObject({ index: 0, build: 2, builds: 2 });
    expect(st().nav.reverse).toBe(true);
    presentation.navigate({ type: 'previous' });
    expect(st()).toMatchObject({ index: 0, build: 1 });
    expect(st().nav.animate).toBe(false);
    presentation.navigate({ type: 'previous' });
    presentation.navigate({ type: 'previous' });
    expect(st()).toMatchObject({ index: 0, build: 0 });
  });

  it('going back uses the transition of the slide being left, reversed', () => {
    load(deck());
    presentation.start({ from: 'first' });
    presentation.goto({ index: 1 });
    expect(st().nav.plan?.preset).toBe('push');
    expect(st().nav.plan?.incoming.reverse).toBe(false);
    expect(st().nav.leaving?.name).toBe('One');
    presentation.navigate({ type: 'previous' });
    expect(st().nav.plan?.incoming.reverse).toBe(true);
    expect(st().nav.leaving?.name).toBe('Two');
    // slide 3 has no transition
    presentation.goto({ index: 2 });
    expect(st().nav.plan).toBeNull();
    expect(st().nav.leaving).toBeNull();
  });

  it('first / last / goto go to build 0 or the given build', () => {
    load(deck());
    presentation.start();
    presentation.goto({ step: 'last' });
    expect(st()).toMatchObject({ index: 2, build: 0, builds: 1 });
    presentation.goto({ index: 0, build: 2 });
    expect(st()).toMatchObject({ index: 0, build: 2 });
    presentation.goto({ step: 'first' });
    expect(st()).toMatchObject({ index: 0, build: 0 });
    presentation.goto({ index: 2, build: 99 });
    expect(st()).toMatchObject({ index: 2, build: 1 });
  });

  it('goto { build } alone moves within the slide (animated only for current + 1)', () => {
    load(deck());
    presentation.start();
    presentation.goto({ build: 1 });
    expect(st()).toMatchObject({ build: 1 });
    expect(st().nav.animate).toBe(true);
    presentation.goto({ build: 0 });
    expect(st().nav.animate).toBe(false);
    presentation.goto({ build: 2 });
    expect(st()).toMatchObject({ build: 2 });
    expect(st().nav.animate).toBe(false);
  });

  it('clamps the build when a live edit removes builds', () => {
    const doc = deck();
    load(doc);
    presentation.start();
    presentation.goto({ build: 2 });
    const next = structuredClone(doc);
    next.pages[0]!.frames[0]!.children[1]!.animations = [];
    act(() => useDoc.setState({ doc: next, rawDoc: next }));
    expect(st()).toMatchObject({ build: 1, builds: 1 });
  });

  it('editor command goto accepts build', async () => {
    const doc = deck();
    load(doc);
    presentation.start();
    const r = await runEditorCommand({ type: 'presentation:goto', build: 2 });
    expect(r).toMatchObject({ index: 0, build: 2, builds: 2 });
    const r2 = await runEditorCommand({ type: 'presentation:goto', index: 2, build: 1 });
    expect(r2).toMatchObject({ index: 2, build: 1 });
  });
});

describe('view', () => {
  it('shows the build indicator', () => {
    load(deck());
    const { getByTestId, queryByTestId } = render(<PresentationView />);
    act(() => void presentation.start());
    expect(getByTestId('presentation-builds').textContent).toContain('0/2');
    fireEvent.click(getByTestId('presentation-next'));
    expect(getByTestId('presentation-counter').textContent).toContain('1 / 3');
    expect(getByTestId('presentation-builds').textContent).toContain('1/2');
    act(() => void presentation.goto({ index: 1 }));
    expect(queryByTestId('presentation-builds')).toBeNull();
  });

  it('mounts two slots during a transition and one after it finishes', async () => {
    const running: { resolve: () => void }[] = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () {
      let resolve!: () => void;
      const finished = new Promise<void>((r) => (resolve = r));
      running.push({ resolve });
      return { finished, cancel() {}, finish() {}, pause() {}, play() {}, persist() {} };
    };
    load(deck());
    const { container } = render(<PresentationView />);
    act(() => void presentation.start());
    const slots = () => container.querySelectorAll('.pres-slot').length;
    expect(slots()).toBe(1);
    running.length = 0;
    act(() => void presentation.goto({ index: 1 }));
    expect(slots()).toBe(2);
    await act(async () => {
      for (const r of running) r.resolve();
    });
    expect(slots()).toBe(1);
  });

  it('a live edit keeps the builds; changing slide and leaving cancel every animation', async () => {
    const made: { id: string; cancelled: boolean; currentTime: number; running: boolean }[] = [];
    proto.animate = function (this: HTMLElement) {
      const a = {
        id: this.dataset.nodeId ?? '',
        cancelled: false,
        currentTime: 0,
        running: false,
        finished: new Promise(() => undefined),
        cancel() {
          a.cancelled = true;
        },
        finish() {},
        pause() {
          a.running = false;
        },
        play() {
          a.running = true;
        },
        persist() {},
      };
      made.push(a);
      return a;
    };
    const doc = deck();
    const [one, two] = doc.pages[0]!.frames as [Node, Node];
    delete two.slideTransition;
    const alive = () => made.filter((a) => !a.cancelled && a.id);
    load(doc);
    const { unmount } = render(<PresentationView />);
    act(() => void presentation.start());
    expect(alive().map((a) => a.running)).toEqual([false, false]);
    // an edit through the MCP: new node objects, same slide, build 0
    const next = structuredClone(doc);
    await act(async () => useDoc.setState({ doc: next, rawDoc: next }));
    expect(alive().map((a) => [a.id, a.running, a.currentTime])).toEqual(
      one.children.map((c) => [c.id, false, 0]),
    );
    act(() => void presentation.navigate({ type: 'next' }));
    expect(alive().map((a) => a.running)).toEqual([true, false]);
    // slide 2 has no animations: nothing of slide 1 stays alive
    await act(async () => void presentation.goto({ index: 1 }));
    expect(alive()).toEqual([]);
    await act(async () => void presentation.goto({ index: 0 }));
    expect(alive()).toHaveLength(2);
    act(() => void presentation.stop());
    unmount();
    expect(alive()).toEqual([]);
  });

  it('cuts instantly without Web Animations', () => {
    proto.animate = undefined;
    load(deck());
    const { container } = render(<PresentationView />);
    act(() => void presentation.start());
    act(() => void presentation.goto({ index: 1 }));
    expect(container.querySelectorAll('.pres-slot').length).toBe(1);
  });
});

describe('magicPairs', () => {
  it('matches unique names on both slides, root frames excluded', () => {
    const a = frame('Logo', [layer('Logo'), layer('Dup'), layer('Dup'), layer('OnlyA')]);
    const b = frame('Logo', [layer('Logo'), layer('Dup'), layer('OnlyB')]);
    const pairs = magicPairs(a, b);
    expect(pairs.map((p) => p.name)).toEqual(['Logo']);
    expect(pairs[0]).toMatchObject({ outId: a.children[0]!.id, inId: b.children[0]!.id });
  });

  it('keeps only the top-most match', () => {
    const a = frame('A', [layer('Card', [], [layer('Title')])]);
    const b = frame('B', [layer('Card', [], [layer('Title')])]);
    expect(magicPairs(a, b).map((p) => p.name)).toEqual(['Card']);
    // nested on one slide only: still skipped
    const c = frame('C', [layer('Card'), layer('Title')]);
    expect(magicPairs(a, c).map((p) => p.name)).toEqual(['Card']);
  });

  it('skips hidden layers and layers that build in on a click', () => {
    const hidden = layer('H');
    hidden.hidden = true;
    const a = frame('A', [layer('H'), layer('X'), layer('Y')]);
    const b = frame('B', [hidden, layer('X', [1]), layer('Y')]);
    expect(magicPairs(a, b).map((p) => p.name)).toEqual(['Y']);
  });
});
