// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { installRenderApi } from './api';
import { makeDoc } from '../test/fixtures';
import type { MockupRenderApi } from './api';

describe('página de render', () => {
  let api: MockupRenderApi;
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    document.head.querySelectorAll('style').forEach((s) => s.remove());
    api = installRenderApi(document.getElementById('root')!);
  });

  it('expõe a API e marca a página como pronta', () => {
    expect(window.__mockupRenderReady).toBe(true);
    expect(window.__mockupRender).toBe(api);
  });

  it('renderiza só o frame do nó em (0,0), sem sombra, com fundo da página', async () => {
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

  it('transparent remove o fundo', async () => {
    const { doc, a } = makeDoc();
    await api.render({ doc, docId: doc.id, nodeId: a.id, transparent: true });
    expect(document.body.style.background).toContain('transparent');
  });

  it('injeta @font-face das fontes embutidas', async () => {
    const { doc, a } = makeDoc();
    doc.fonts = [{ family: 'Minha', source: 'file', files: ['fonts/m.woff2'] }];
    await api.render({ doc, docId: doc.id, nodeId: a.id });
    expect(document.body.innerHTML).toContain(`/assets/${doc.id}/fonts/m.woff2`);
  });

  it('measure devolve a subárvore e erra para nó fora do último render', async () => {
    const { doc, frame, a } = makeDoc();
    await api.render({ doc, docId: doc.id, nodeId: a.id });
    const tree = api.measure(frame.id);
    expect(tree.id).toBe(frame.id);
    expect(tree.children.map((c) => c.id)).toContain(a.id);
    expect(() => api.measure('nada')).toThrow(/não está no último render/);
  });

  it('erra com nó inexistente', async () => {
    const { doc } = makeDoc();
    await expect(api.render({ doc, docId: doc.id, nodeId: 'x' })).rejects.toThrow(/não encontrado/);
  });
});
