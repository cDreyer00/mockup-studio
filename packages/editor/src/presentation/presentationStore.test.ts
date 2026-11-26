// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPONENT_EDIT_PAGE_ID, createDocument, createNodeFromTag } from '@mockup/core';
import type { Document, Node } from '@mockup/core';
import type { MockupDesktopApi } from '../desktop/bridge';
import { fxClock, useFxClock } from '../fx/clock';
import { mergeDoc, useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { presentation, usePresentation } from './presentationStore';

function frame(name: string, child?: Node): Node {
  return createNodeFromTag('div', {
    isRoot: true,
    name,
    styles: { width: '400px', height: '300px' },
    children: child ? [child] : [],
  });
}

interface Fixture {
  doc: Document;
  f1: Node;
  f2: Node;
  f3: Node;
  inner2: Node;
}

function makeDeck(): Fixture {
  const doc = createDocument('Deck');
  const inner2 = createNodeFromTag('p', { name: 'Inner', text: 'two' });
  const f1 = frame('One');
  const f2 = frame('Two', inner2);
  const f3 = frame('Three');
  doc.pages[0]!.frames.push(f1, f2, f3);
  return { doc, f1, f2, f3, inner2 };
}

function load(doc: Document): void {
  useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
}

/** Applies an edit to the loaded document the way `doc:changed` does (structural sharing). */
function edit(fn: (d: Document) => void): void {
  const prev = useDoc.getState().doc!;
  const next = structuredClone(prev);
  fn(next);
  const merged = mergeDoc(prev, next);
  useDoc.setState({ doc: merged, rawDoc: merged });
}

const names = (): string[] => usePresentation.getState().slides.map((s) => s.name);

beforeEach(() => {
  useUi.setState({
    selection: [],
    hoverId: null,
    pageId: null,
    editingComponentId: null,
    componentEdit: null,
    focusRequest: null,
  });
  useFxClock.setState({ playing: true, manual: null });
});

afterEach(() => {
  presentation.stop();
  delete window.mockupDesktop;
  useDoc.setState({ doc: null, rawDoc: null, activeDocId: null });
  vi.restoreAllMocks();
});

describe('presentation.start', () => {
  it('throws without a document', () => {
    expect(() => presentation.start()).toThrow(/no document/i);
  });

  it('throws on a page with no visible frames', () => {
    const { doc, f1, f2, f3 } = makeDeck();
    f1.hidden = f2.hidden = f3.hidden = true;
    load(doc);
    expect(() => presentation.start()).toThrow('This page has no visible frames to present.');
    expect(presentation.getState().active).toBe(false);
  });

  it('starts from the first slide by default and lists the visible frames in order', () => {
    const { doc, f2 } = makeDeck();
    f2.hidden = true;
    load(doc);
    const st = presentation.start();
    expect(st).toMatchObject({ active: true, docId: doc.id, index: 0 });
    expect(names()).toEqual(['One', 'Three']);
    expect(st.frameId).toBe(doc.pages[0]!.frames[0]!.id);
  });

  it('starts from the frame of the selection (also for a node inside a frame)', () => {
    const { doc, f2, inner2 } = makeDeck();
    load(doc);
    useUi.setState({ selection: [inner2.id] });
    expect(presentation.start().frameId).toBe(f2.id);
  });

  it('from "first" ignores the selection', () => {
    const { doc, f3 } = makeDeck();
    load(doc);
    useUi.setState({ selection: [f3.id] });
    expect(presentation.start({ from: 'first' }).index).toBe(0);
  });

  it('frameId wins over the selection and accepts a node inside the frame', () => {
    const { doc, f1, f3, inner2, f2 } = makeDeck();
    load(doc);
    useUi.setState({ selection: [f1.id] });
    expect(presentation.start({ frameId: f3.id }).index).toBe(2);
    expect(presentation.start({ frameId: inner2.id }).frameId).toBe(f2.id);
    expect(() => presentation.start({ frameId: 'nope' })).toThrow(/not a slide/);
  });

  it('presents an explicit page and rejects unknown ones', () => {
    const { doc } = makeDeck();
    doc.pages.push({ id: 'p2', name: 'Second', frames: [frame('Other')], background: '' });
    load(doc);
    expect(presentation.start({ pageId: 'p2' })).toMatchObject({ pageId: 'p2' });
    expect(names()).toEqual(['Other']);
    expect(() => presentation.start({ pageId: 'zzz' })).toThrow(/not found/);
  });

  it('in main component edit mode presents the page you came from', () => {
    const { doc } = makeDeck();
    doc.pages.push({
      id: COMPONENT_EDIT_PAGE_ID,
      name: 'Component',
      frames: [frame('Comp')],
      background: '',
    });
    load(doc);
    useUi.setState({
      pageId: COMPONENT_EDIT_PAGE_ID,
      editingComponentId: 'c1',
      componentEdit: { fromPageId: doc.pages[0]!.id, originId: null, width: null },
    });
    expect(presentation.start()).toMatchObject({ pageId: doc.pages[0]!.id, index: 0 });
    expect(names()).toEqual(['One', 'Two', 'Three']);
  });

  it('forces the animations clock to play and restores it on stop', () => {
    load(makeDeck().doc);
    fxClock.setPlaying(false);
    presentation.start();
    expect(useFxClock.getState().playing).toBe(true);
    presentation.stop();
    expect(useFxClock.getState().playing).toBe(false);
  });

  it('restarting while presenting swaps the slides in place and keeps what to restore', () => {
    const { doc, f3 } = makeDeck();
    const other = frame('Other');
    doc.pages.push({ id: 'p2', name: 'Second', frames: [other], background: '' });
    load(doc);
    fxClock.setPlaying(false);
    presentation.start({ from: 'first' });
    expect(presentation.start({ pageId: 'p2' })).toMatchObject({ active: true, pageId: 'p2' });
    expect(names()).toEqual(['Other']);
    expect(presentation.start({ frameId: f3.id })).toMatchObject({
      pageId: doc.pages[0]!.id,
      index: 2,
    });
    presentation.stop();
    expect(useFxClock.getState().playing).toBe(false);
    expect(useUi.getState().selection).toEqual([f3.id]);
  });
});

describe('navigation', () => {
  it('navigates and stays at the edges', () => {
    load(makeDeck().doc);
    presentation.start();
    const idx = () => usePresentation.getState().index;
    presentation.navigate({ type: 'previous' });
    expect(idx()).toBe(0);
    presentation.navigate({ type: 'next' });
    presentation.navigate({ type: 'next' });
    presentation.navigate({ type: 'next' });
    expect(idx()).toBe(2);
    presentation.navigate({ type: 'first' });
    expect(idx()).toBe(0);
    presentation.navigate({ type: 'last' });
    expect(idx()).toBe(2);
    presentation.navigate({ type: 'goto', index: 1 });
    expect(idx()).toBe(1);
  });

  it('goto by index, frame id and step; rejects unknown targets', () => {
    const { doc, f3 } = makeDeck();
    load(doc);
    expect(() => presentation.goto({ index: 1 })).toThrow('No presentation is running.');
    presentation.start();
    expect(presentation.goto({ index: 1 }).index).toBe(1);
    expect(presentation.goto({ frameId: f3.id }).index).toBe(2);
    expect(presentation.goto({ step: 'first' }).index).toBe(0);
    expect(presentation.goto({ index: 99 }).index).toBe(2);
    expect(() => presentation.goto({ frameId: 'nope' })).toThrow(/not a slide/);
    expect(() => presentation.goto({})).toThrow(/index, frameId, step or build/);
  });

  it('navigating while inactive is a no-op', () => {
    load(makeDeck().doc);
    presentation.navigate({ type: 'next' });
    expect(presentation.getState().active).toBe(false);
  });
});

describe('live updates', () => {
  it('editing the content keeps the slide', () => {
    const { doc, f2, inner2 } = makeDeck();
    load(doc);
    presentation.start({ frameId: f2.id });
    edit((d) => {
      d.pages[0]!.frames[1]!.children[0]!.text = 'changed';
    });
    expect(presentation.getState()).toMatchObject({ active: true, index: 1, frameId: f2.id });
    expect(inner2.id).toBeTruthy();
  });

  it('a frame added before the current one keeps the current frame', () => {
    const { doc, f2 } = makeDeck();
    load(doc);
    presentation.start({ frameId: f2.id });
    edit((d) => d.pages[0]!.frames.unshift(frame('Zero')));
    expect(presentation.getState()).toMatchObject({ index: 2, frameId: f2.id });
    expect(names()).toEqual(['Zero', 'One', 'Two', 'Three']);
  });

  it('reordering keeps the current frame', () => {
    const { doc, f1 } = makeDeck();
    load(doc);
    presentation.start({ frameId: f1.id });
    edit((d) => d.pages[0]!.frames.reverse());
    expect(presentation.getState()).toMatchObject({ index: 2, frameId: f1.id });
  });

  it('removing the current frame clamps to the same position', () => {
    const { doc, f2, f3 } = makeDeck();
    load(doc);
    presentation.start({ frameId: f3.id });
    edit((d) => d.pages[0]!.frames.pop());
    expect(presentation.getState()).toMatchObject({ index: 1, frameId: f2.id });
  });

  it('hiding the current frame moves to a neighbour', () => {
    const { doc, f2, f3 } = makeDeck();
    load(doc);
    presentation.start({ frameId: f2.id });
    edit((d) => {
      d.pages[0]!.frames[1]!.hidden = true;
    });
    expect(presentation.getState()).toMatchObject({ index: 1, frameId: f3.id });
    expect(names()).toEqual(['One', 'Three']);
  });

  it('removing every frame keeps presenting an empty stage ("0 / 0")', () => {
    load(makeDeck().doc);
    presentation.start();
    edit((d) => {
      d.pages[0]!.frames = [];
    });
    expect(presentation.getState()).toMatchObject({ active: true, index: -1, frameId: null });
    expect(presentation.getState().slides).toEqual([]);
    // Frames come back: the presentation recovers.
    edit((d) => d.pages[0]!.frames.push(frame('Back')));
    expect(presentation.getState()).toMatchObject({ index: 0 });
  });

  it('stops when the presented page is deleted', () => {
    const { doc } = makeDeck();
    doc.pages.push({ id: 'p2', name: 'Second', frames: [frame('Other')], background: '' });
    load(doc);
    presentation.start({ pageId: 'p2' });
    edit((d) => {
      d.pages = d.pages.filter((p) => p.id !== 'p2');
    });
    expect(presentation.getState().active).toBe(false);
  });

  it('stops when the active document changes or closes', () => {
    load(makeDeck().doc);
    presentation.start();
    useDoc.setState({ doc: null, rawDoc: null, activeDocId: null });
    expect(presentation.getState().active).toBe(false);

    const other = makeDeck().doc;
    load(makeDeck().doc);
    presentation.start();
    load(other);
    expect(presentation.getState().active).toBe(false);
  });
});

describe('restoring the editor on stop', () => {
  it('keeps the selection when the last shown frame is the start frame', () => {
    const { doc, f2, inner2 } = makeDeck();
    load(doc);
    useUi.setState({ selection: [inner2.id] });
    presentation.start();
    presentation.navigate({ type: 'next' });
    presentation.navigate({ type: 'previous' });
    presentation.stop();
    expect(useUi.getState().selection).toEqual([inner2.id]);
    expect(f2.id).toBeTruthy();
  });

  it('selects the last shown frame otherwise and clears hover', () => {
    const { doc, f3 } = makeDeck();
    load(doc);
    useUi.setState({ selection: [], hoverId: 'x' });
    presentation.start({ from: 'first' });
    presentation.navigate({ type: 'last' });
    presentation.stop();
    expect(useUi.getState().selection).toEqual([f3.id]);
    expect(useUi.getState().hoverId).toBeNull();
    expect(useUi.getState().viewport).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('keeps the page and view when another page was presented (MCP)', () => {
    const { doc } = makeDeck();
    const other = frame('Other');
    doc.pages.push({ id: 'p2', name: 'Second', frames: [other], background: '' });
    load(doc);
    useUi.setState({ selection: ['keep'] });
    presentation.start({ pageId: 'p2' });
    presentation.stop();
    expect(useUi.getState()).toMatchObject({ pageId: null, selection: ['keep'] });
    expect(useUi.getState().focusRequest).toBeNull();
    expect(useUi.getState().viewport).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('gives the focus back to the element focused before (e.g. the Present button)', () => {
    load(makeDeck().doc);
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    presentation.start();
    button.blur();
    presentation.stop();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('does not touch the selection in component edit mode', () => {
    const { doc } = makeDeck();
    doc.pages.push({
      id: COMPONENT_EDIT_PAGE_ID,
      name: 'Component',
      frames: [frame('Comp')],
      background: '',
    });
    load(doc);
    useUi.setState({
      pageId: COMPONENT_EDIT_PAGE_ID,
      selection: ['keep'],
      editingComponentId: 'c1',
      componentEdit: { fromPageId: doc.pages[0]!.id, originId: null, width: null },
    });
    presentation.start();
    presentation.navigate({ type: 'last' });
    presentation.stop();
    expect(useUi.getState().selection).toEqual(['keep']);
    expect(useUi.getState().pageId).toBe(COMPONENT_EDIT_PAGE_ID);
  });
});

describe('full screen', () => {
  function desktop(over: Partial<MockupDesktopApi> = {}) {
    let leave: () => void = () => undefined;
    const api = {
      isDesktop: true,
      platform: 'win32',
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      onMenu: vi.fn(() => () => undefined),
      setDocumentState: vi.fn(),
      setPresentationFullScreen: vi.fn(async (on: boolean) => on),
      onLeaveFullScreen: vi.fn((cb: () => void) => {
        leave = cb;
        return () => undefined;
      }),
      ...over,
    } as unknown as MockupDesktopApi;
    window.mockupDesktop = api;
    return { api, leave: () => leave() };
  }

  it('desktop: enters on start, leaves on stop and stops when the window leaves it', async () => {
    const { api, leave } = desktop();
    load(makeDeck().doc);
    presentation.start();
    await presentation.settled();
    expect(api.setPresentationFullScreen).toHaveBeenCalledWith(true);
    expect(presentation.getState().fullscreen).toBe(true);
    presentation.stop();
    expect(api.setPresentationFullScreen).toHaveBeenLastCalledWith(false);

    presentation.start();
    leave();
    expect(presentation.getState().active).toBe(false);
  });

  it('desktop: restarting while presenting does not leave and re-enter full screen', async () => {
    const { api } = desktop();
    const { doc, f3 } = makeDeck();
    load(doc);
    presentation.start();
    await presentation.settled();
    presentation.start({ frameId: f3.id });
    await presentation.settled();
    expect(api.setPresentationFullScreen).toHaveBeenCalledTimes(1);
    expect(presentation.getState()).toMatchObject({ active: true, index: 2, fullscreen: true });
  });

  it('works with an older desktop build without the full screen API', () => {
    desktop({ setPresentationFullScreen: undefined, onLeaveFullScreen: undefined });
    load(makeDeck().doc);
    expect(presentation.start().active).toBe(true);
    expect(presentation.getState().fullscreen).toBe(false);
  });

  it('browser: requests full screen synchronously and survives a refusal', async () => {
    const request = vi.fn(() => Promise.reject(new Error('needs a gesture')));
    document.documentElement.requestFullscreen = request;
    load(makeDeck().doc);
    presentation.start();
    expect(request).toHaveBeenCalledTimes(1);
    await presentation.settled();
    expect(presentation.getState()).toMatchObject({ active: true, fullscreen: false });
    delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
  });

  it('browser: leaving full screen stops the presentation', async () => {
    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
    document.documentElement.requestFullscreen = vi.fn(async () => {
      fsEl = document.documentElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    document.exitFullscreen = vi.fn(async () => undefined);
    load(makeDeck().doc);
    presentation.start();
    await presentation.settled();
    expect(presentation.getState().fullscreen).toBe(true);
    fsEl = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(presentation.getState().active).toBe(false);
    delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
    delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
  });
});

describe('edge cases (QA)', () => {
  it('a single-frame deck clamps next/previous/home/end and every goto', () => {
    const doc = createDocument('One');
    const only = frame('Only');
    doc.pages[0]!.frames.push(only);
    load(doc);
    presentation.start();
    for (const type of ['next', 'previous', 'first', 'last'] as const) {
      presentation.navigate({ type });
      expect(presentation.getState()).toMatchObject({ index: 0, frameId: only.id });
    }
    expect(presentation.goto({ index: 5 }).index).toBe(0);
    expect(presentation.goto({ index: -3 }).index).toBe(0);
  });

  it('goto with an out-of-range index clamps instead of throwing', () => {
    load(makeDeck().doc);
    presentation.start();
    expect(presentation.goto({ index: -1 }).index).toBe(0);
    expect(presentation.goto({ index: 1000 }).index).toBe(2);
  });

  it('rejects a frame that exists on another page when pageId is given', () => {
    const { doc, f1 } = makeDeck();
    const other = frame('Elsewhere');
    doc.pages.push({ id: 'p2', name: 'Second', frames: [other], background: '' });
    load(doc);
    expect(() => presentation.start({ pageId: 'p2', frameId: f1.id })).toThrow(/not a slide/);
    expect(presentation.getState().active).toBe(false);
    presentation.start({ pageId: 'p2', frameId: other.id });
    expect(() => presentation.goto({ frameId: f1.id })).toThrow(/not a slide/);
  });

  it('rejects a hidden frame as the start frame and a failed start leaves a running one untouched', () => {
    const { doc, f1, f2 } = makeDeck();
    f2.hidden = true;
    load(doc);
    expect(() => presentation.start({ frameId: f2.id })).toThrow(/not a slide/);
    presentation.start({ frameId: f1.id });
    presentation.navigate({ type: 'next' });
    expect(() => presentation.start({ frameId: 'nope' })).toThrow();
    expect(presentation.getState()).toMatchObject({ active: true, index: 1 });
  });

  it('deleting the current (last) frame while presenting moves to the new last one', () => {
    const { doc, f3 } = makeDeck();
    load(doc);
    presentation.start({ frameId: f3.id });
    edit((d) => {
      d.pages[0]!.frames.pop();
    });
    expect(presentation.getState()).toMatchObject({ active: true, index: 1 });
    expect(names()).toEqual(['One', 'Two']);
  });

  it('after every frame is deleted, new frames appear again and the show resumes at the first', () => {
    const { doc } = makeDeck();
    load(doc);
    presentation.start();
    edit((d) => {
      d.pages[0]!.frames = [];
    });
    expect(usePresentation.getState()).toMatchObject({ active: true, index: -1 });
    expect(presentation.getState().frameId).toBeNull();
    presentation.navigate({ type: 'next' });
    expect(usePresentation.getState().index).toBe(-1);
    edit((d) => {
      d.pages[0]!.frames.push(frame('Fresh'));
    });
    expect(presentation.getState()).toMatchObject({ index: 0 });
    expect(names()).toEqual(['Fresh']);
    presentation.stop();
    expect(presentation.getState().active).toBe(false);
  });

  it('switching the editor page while presenting keeps the show on its page; Esc keeps the editor page', () => {
    const { doc, f1, f2 } = makeDeck();
    doc.pages.push({ id: 'p2', name: 'Second', frames: [frame('Other')], background: '' });
    load(doc);
    presentation.start({ frameId: f1.id });
    presentation.navigate({ type: 'next' });
    useUi.setState({ pageId: 'p2' });
    expect(presentation.getState()).toMatchObject({ active: true, pageId: doc.pages[0]!.id });
    presentation.stop();
    expect(useUi.getState().pageId).toBe('p2');
    // the shown page is not the presented one: the selection is not touched
    expect(useUi.getState().selection).not.toContain(f2.id);
  });

  it('restarting on another page via MCP switches slides and resets the index', () => {
    const { doc } = makeDeck();
    doc.pages.push({ id: 'p2', name: 'Second', frames: [frame('A'), frame('B')], background: '' });
    load(doc);
    presentation.start();
    presentation.navigate({ type: 'last' });
    const st = presentation.start({ pageId: 'p2' });
    expect(st).toMatchObject({ pageId: 'p2', index: 0 });
    expect(names()).toEqual(['A', 'B']);
  });

  it('a start frame given as a deep descendant starts at its top-level frame', () => {
    const { doc, f2 } = makeDeck();
    const deep = createNodeFromTag('span', { name: 'Deep', text: 'x' });
    const mid = createNodeFromTag('div', { name: 'Mid', children: [deep] });
    f2.children.push(mid);
    load(doc);
    useUi.setState({ selection: [deep.id] });
    expect(presentation.start().frameId).toBe(f2.id);
    presentation.stop();
    expect(presentation.start({ frameId: deep.id }).frameId).toBe(f2.id);
  });
});
