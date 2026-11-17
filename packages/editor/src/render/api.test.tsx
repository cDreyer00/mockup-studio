// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
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
    doc.pages[0]!.frames.push({ ...frame, id: 'outro', children: [] });
    const box = await api.render({ doc, docId: doc.id, nodeId: a.id });
    expect(box.frameId).toBe(frame.id);
    expect(document.querySelector('[data-node-id="outro"]')).toBeNull();
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
});
