import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from '@mockup/core';
import { DocumentStore } from './store.js';
import { makeWorkspace } from './test-utils.js';

describe('DocumentStore', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let store: DocumentStore;

  beforeEach(() => {
    ws = makeWorkspace();
    store = new DocumentStore({ dataDir: ws.dataDir, autosaveMs: 50 });
  });
  afterEach(async () => {
    await store.closeAll();
    ws.cleanup();
  });

  const bg = (id: string, color: string) =>
    store.applyOps(
      id,
      [{ type: 'updateStyles', nodeIds: [ws.frameId], styles: { background: color } }],
      {
        source: 'mcp',
      },
    );
  const readBg = () =>
    parseDocument(fs.readFileSync(ws.file, 'utf8')).pages[0]!.frames[0]!.style['background'];

  it('abre, reaproveita documento já aberto e resolve o ativo', async () => {
    const a = await store.open(ws.file);
    const b = await store.open(ws.file);
    expect(b.docId).toBe(a.docId);
    expect(store.list()).toHaveLength(1);
    expect(store.resolveDocId()).toBe(a.docId);
  });

  it('resolveDocId sem documento lança mensagem orientativa', () => {
    expect(() => store.resolveDocId()).toThrow(/Nenhum documento aberto/);
  });

  it('create acrescenta extensão e salva', async () => {
    const info = await store.create(path.join(ws.dir, 'novo'), 'Novo');
    expect(info.path).toMatch(/novo\.mockup\.json$/);
    expect(parseDocument(fs.readFileSync(info.path!, 'utf8')).name).toBe('Novo');
  });

  it('autosave com debounce e save explícito', async () => {
    const { docId } = await store.open(ws.file);
    bg(docId, '#111111');
    expect(store.list()[0]!.dirty).toBe(true);
    expect(readBg()).toBe('#ffffff');
    await new Promise((r) => setTimeout(r, 400));
    expect(readBg()).toBe('#111111');
    expect(store.list()[0]!.dirty).toBe(false);

    bg(docId, '#222222');
    await store.save(docId);
    expect(readBg()).toBe('#222222');
    expect(fs.readdirSync(ws.dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('undo/redo emitem doc:changed com a origem', async () => {
    const { docId } = await store.open(ws.file);
    const events: Array<{ source: string; revision: number }> = [];
    store.on('doc:changed', (e) => events.push({ source: e.source, revision: e.revision }));
    bg(docId, '#333333');
    expect(store.undo(docId, 'editor')).not.toBeNull();
    expect(store.get(docId).pages[0]!.frames[0]!.style['background']).toBe('#ffffff');
    expect(store.redo(docId, 'mcp')).not.toBeNull();
    expect(store.get(docId).pages[0]!.frames[0]!.style['background']).toBe('#333333');
    expect(events.map((e) => e.source)).toEqual(['mcp', 'editor', 'mcp']);
    expect(store.undo(docId, 'editor')).not.toBeNull();
    expect(store.undo(docId, 'editor')).toBeNull();
  });

  it('seleção e close salvam pendências', async () => {
    const { docId } = await store.open(ws.file);
    store.setSelection(docId, [ws.frameId], 'editor');
    expect(store.getSelection(docId)).toEqual([ws.frameId]);
    bg(docId, '#444444');
    await store.close(docId);
    expect(readBg()).toBe('#444444');
    expect(store.getActive()).toBeNull();
  });
});
