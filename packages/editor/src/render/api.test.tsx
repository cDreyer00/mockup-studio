// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeAnimation } from '@mockup/core';
import { useFxClock } from '../fx/clock';
import { installRenderApi } from './api';
import { makeDoc } from '../test/fixtures';
import type { MockupRenderApi } from './api';

describe('render page', () => {
  let api: MockupRenderApi;
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    document.head.querySelectorAll('style').forEach((s) => s.remove());
    api = installRenderApi(document.getElementById('root')!);
  });

  it('exposes the API and marks the page as ready', () => {
    expect(window.__mockupRenderReady).toBe(true);
    expect(window.__mockupRender).toBe(api);
  });

  it('renders only the node frame at (0,0), without shadow, with the page background', async () => {
    const { doc, frame, a } = makeDoc();
    doc.pages[0]!.background = '#abcdef';
    doc.pages[0]!.frames.push({ ...frame, id: 'other', children: [] });
    const box = await api.render({ doc, docId: doc.id, nodeId: a.id });
    expect(box.frameId).toBe(frame.id);
    expect(document.querySelector('[data-node-id="other"]')).toBeNull();
    const el = document.querySelector<HTMLElement>(`[data-node-id="${frame.id}"]`)!;
    expect(el.style.left).toBe('0px');
    expect(el.style.boxShadow).toBe('none');
    expect(document.body.style.background).toContain('#abcdef');
  });

  it('transparent removes the background', async () => {
    const { doc, a } = makeDoc();
    await api.render({ doc, docId: doc.id, nodeId: a.id, transparent: true });
    expect(document.body.style.background).toContain('transparent');
  });

  it('injects @font-face for the embedded fonts', async () => {
    const { doc, a } = makeDoc();
    doc.fonts = [{ family: 'Minha', source: 'file', files: ['fonts/m.woff2'] }];
    await api.render({ doc, docId: doc.id, nodeId: a.id });
    expect(document.body.innerHTML).toContain(`/assets/${doc.id}/fonts/m.woff2`);
  });

  it('measure returns the subtree and throws for a node outside the last render', async () => {
    const { doc, frame, a } = makeDoc();
    await api.render({ doc, docId: doc.id, nodeId: a.id });
    const tree = api.measure(frame.id);
    expect(tree.id).toBe(frame.id);
    expect(tree.children.map((c) => c.id)).toContain(a.id);
    expect(() => api.measure('nothing')).toThrow(/is not in the last render/);
  });

  it('throws for a nonexistent node', async () => {
    const { doc } = makeDoc();
    await expect(api.render({ doc, docId: doc.id, nodeId: 'x' })).rejects.toThrow(/not found/);
  });

  it('hidden node (or inside a hidden one) throws in render and measure; hidden root frame renders', async () => {
    const { doc, frame, a, c } = makeDoc();
    a.hidden = true;
    await expect(api.render({ doc, docId: doc.id, nodeId: a.id })).rejects.toThrow(
      `Node "${a.id}" is hidden; show it with set_node_flags`,
    );
    a.hidden = false;
    frame.hidden = true;
    await api.render({ doc, docId: doc.id, nodeId: a.id });
    expect(api.measure(frame.id).id).toBe(frame.id);
    frame.hidden = false;
    const inner = c.children[0]!;
    c.hidden = true;
    await expect(api.render({ doc, docId: doc.id, nodeId: inner.id })).rejects.toThrow(
      `inside "${c.id}", which is hidden`,
    );
    c.hidden = false;
    a.hidden = false;
    await api.render({ doc, docId: doc.id, nodeId: frame.id });
    a.hidden = true;
    expect(() => api.measure(a.id)).toThrow(/hidden/);
  });

  describe('motion', () => {
    const anims: { target: Element; currentTime: number | null; cancelled: boolean }[] = [];

    beforeEach(() => {
      anims.length = 0;
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (
        this: Element,
      ) {
        const a = {
          target: this,
          currentTime: 0 as number | null,
          startTime: null,
          cancelled: false,
          pause() {},
          play() {},
          cancel() {
            a.cancelled = true;
          },
          persist() {},
        };
        anims.push(a);
        return a;
      };
    });
    afterEach(() => {
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
      vi.restoreAllMocks();
    });

    const animated = (animations: NodeAnimation[]) => {
      const made = makeDoc();
      made.b.animations = animations;
      return made;
    };
    const lastTime = () => anims[anims.length - 1]?.currentTime;

    it('without time or build the design state has no Web Animations and the clock is at 0', async () => {
      const { doc, frame } = animated([{ kind: 'in', preset: 'fade' }]);
      await api.render({ doc, docId: doc.id, nodeId: frame.id });
      expect(anims).toHaveLength(0);
      expect(useFxClock.getState().manual).toBe(0);
    });

    it('time seeks the animations and drives the effects clock', async () => {
      const { doc, frame } = animated([{ kind: 'in', preset: 'fade' }]);
      await api.render({ doc, docId: doc.id, nodeId: frame.id, time: 0.4 });
      expect(anims.length).toBeGreaterThan(0);
      expect(lastTime()).toBe(400);
      expect(useFxClock.getState().manual).toBeCloseTo(0.4);
      // back to the design state on the next render without time
      await api.render({ doc, docId: doc.id, nodeId: frame.id });
      expect(useFxClock.getState().manual).toBe(0);
    });

    // Each capture receives a freshly deserialized document: same frame, new node objects.
    it('keeps seeking when the same frame is captured again from a new document object', async () => {
      const { doc, frame } = animated([{ kind: 'in', preset: 'fade', build: 1, duration: 600 }]);
      const alive = () => anims.filter((a) => !a.cancelled).map((a) => a.currentTime);
      const capture = (at: { time?: number; build?: number }) =>
        api.render({ doc: structuredClone(doc), docId: doc.id, nodeId: frame.id, ...at });
      await capture({});
      expect(alive()).toEqual([]);
      await capture({ build: 0 });
      expect(alive()).toEqual([0]);
      await capture({ time: 0.25 });
      expect(alive()).toEqual([250]);
      await capture({ build: 1 });
      expect(alive()).toEqual([600]);
      await capture({});
      expect(alive()).toEqual([]);
    });

    it('build seeks to the state after that click build; the clock follows the linear time', async () => {
      const { doc, frame } = animated([{ kind: 'in', preset: 'fade', build: 1, duration: 600 }]);
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 0 });
      expect(lastTime()).toBe(0);
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 1 });
      expect(lastTime()).toBe(600);
      expect(useFxClock.getState().manual).toBeCloseTo(0.6);
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 1, time: 0.2 });
      expect(lastTime()).toBe(200);
    });

    it('build counts clicks, not build numbers, when they are sparse', async () => {
      // builds 0, 2, 5: build 1 = after the first click = build 2 finished, build 5 not started
      const { doc, frame } = animated([
        { kind: 'in', preset: 'fade', build: 2, duration: 600 },
        { kind: 'in', preset: 'fade', build: 5, duration: 400, delay: 0 },
      ]);
      const timesOf = () => anims.map((a) => a.currentTime);
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 1 });
      expect(timesOf()).toEqual([600, 0]);
      expect(useFxClock.getState().manual).toBeCloseTo(0.6);
      anims.length = 0;
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 1, time: 0.3 });
      expect(timesOf()).toEqual([300, 0]);
      anims.length = 0;
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 2 });
      expect(timesOf()).toEqual([600, 400]);
      expect(useFxClock.getState().manual).toBeCloseTo(1);
      // past the last click: everything played
      anims.length = 0;
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 9 });
      expect(timesOf()).toEqual([600, 400]);
      // the filmstrip reads build the same way
      anims.length = 0;
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 1, times: [0.1] });
      expect(timesOf()).toEqual([100, 0]);
      expect(useFxClock.getState().manual).toBeCloseTo(0.1);
    });

    it('setTime seeks the node animations too', async () => {
      const { doc, frame } = animated([{ kind: 'in', preset: 'fade' }]);
      await api.render({ doc, docId: doc.id, nodeId: frame.id });
      await api.setTime(0.25);
      expect(lastTime()).toBe(250);
      expect(useFxClock.getState().manual).toBeCloseTo(0.25);
    });

    it('validates time, build, times and columns', async () => {
      const { doc, frame } = makeDoc();
      const base = { doc, docId: doc.id, nodeId: frame.id };
      await expect(api.render({ ...base, time: -1 })).rejects.toThrow(/time/);
      await expect(api.render({ ...base, build: 1.5 })).rejects.toThrow(/build/);
      await expect(api.render({ ...base, times: [] })).rejects.toThrow(/times/);
      await expect(api.render({ ...base, times: [0, Number.NaN] })).rejects.toThrow(/times/);
      await expect(
        api.render({ ...base, times: Array.from({ length: 13 }, (_, i) => i) }),
      ).rejects.toThrow(/times/);
      await expect(api.render({ ...base, times: [0], columns: 0 })).rejects.toThrow(/columns/);
    });

    it('filmstrip renders one labelled cell per time and a box covering the grid', async () => {
      const { doc, frame } = animated([{ kind: 'in', preset: 'fade' }]);
      const rect = (w: number, h: number) =>
        ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0 }) as DOMRect;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.dataset.filmstrip !== undefined ? rect(1000, 400) : rect(400, 300);
      });
      const box = await api.render({
        doc,
        docId: doc.id,
        nodeId: frame.id,
        times: [0, 0.4, 1],
        columns: 2,
      });
      const cells = document.querySelectorAll<HTMLElement>('[data-filmstrip-cell]');
      expect(cells).toHaveLength(3);
      expect(cells[0]!.style.width).toBe('400px');
      expect(cells[0]!.style.height).toBe('300px');
      expect(
        Array.from(document.querySelectorAll('[data-filmstrip-label]')).map((l) => l.textContent),
      ).toEqual(['0.00 s', '0.40 s', '1.00 s']);
      const grid = document.querySelector<HTMLElement>('[data-filmstrip]')!;
      expect(grid.style.gridTemplateColumns).toBe('repeat(2, max-content)');
      expect(box).toMatchObject({
        frameId: frame.id,
        frameWidth: 1000,
        frameHeight: 400,
        x: 0,
        y: 0,
        width: 1000,
        height: 400,
      });
      expect(() => api.measure(frame.id)).toThrow(/filmstrip/);
      // each cell has its own seek
      expect(anims.map((a) => a.currentTime).sort((x, y) => x! - y!)).toEqual([0, 400, 1000]);
    });

    it('filmstrip labels are relative to the build and a later single render drops the cells', async () => {
      const { doc, frame } = animated([{ kind: 'in', preset: 'fade', build: 1 }]);
      await api.render({ doc, docId: doc.id, nodeId: frame.id, build: 1, times: [0.4] });
      expect(document.querySelector('[data-filmstrip-label]')?.textContent).toBe(
        'click 1 + 0.40 s',
      );
      await api.render({ doc, docId: doc.id, nodeId: frame.id });
      expect(document.querySelector('[data-filmstrip]')).toBeNull();
      expect(api.measure(frame.id).id).toBe(frame.id);
    });

    it('measure collects the characters of split text spans', async () => {
      const { doc, frame, b } = animated([{ kind: 'in', preset: 'fade', split: 'words' }]);
      b.text = 'hello world';
      let n = 0;
      vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
        () => [{ left: n++ * 10, top: 0, width: 10, height: 16 }] as unknown as DOMRectList,
      );
      await api.render({ doc, docId: doc.id, nodeId: frame.id });
      expect(document.querySelectorAll('[data-motion-seg]').length).toBeGreaterThan(0);
      const joined = (api.measure(b.id).lines ?? []).map((l) => l.text).join('');
      expect(joined).toContain('hello');
      expect(joined).toContain('world');
    });
  });
});
