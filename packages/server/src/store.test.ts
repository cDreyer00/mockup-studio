import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNode, parseDocument } from '@mockup/core';
import { DocumentStore } from './store.js';
import { readDaemonInfo, readRecent, removeDaemonInfo, writeDaemonInfo } from './paths.js';
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

  it('create normaliza a extensão e não sobrescreve arquivo existente', async () => {
    const info = await store.create(path.join(ws.dir, 'foo.json'), 'Foo');
    expect(info.path!.endsWith('foo.mockup.json')).toBe(true);
    expect(fs.existsSync(info.path!)).toBe(true);
    const before = fs.readFileSync(ws.file, 'utf8');
    await expect(store.create(ws.file, 'Outro')).rejects.toThrow(/já existe/);
    expect(fs.readFileSync(ws.file, 'utf8')).toBe(before);
  });

  it('saves em fila: o arquivo fica com a última revisão e dirty=false', async () => {
    const { docId } = await store.open(ws.file);
    bg(docId, '#111111');
    const p1 = store.save(docId);
    bg(docId, '#222222');
    const p2 = store.save(docId);
    await Promise.all([p1, p2]);
    expect(readBg()).toBe('#222222');
    expect(store.getInfo(docId).dirty).toBe(false);
    expect(fs.readdirSync(ws.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('mudança durante um save em andamento mantém dirty=true', async () => {
    const { docId } = await store.open(ws.file);
    bg(docId, '#111111');
    const p1 = store.save(docId);
    await new Promise((r) => setImmediate(r)); // deixa o save 1 começar a gravar
    bg(docId, '#333333');
    await p1;
    expect(store.getInfo(docId).dirty).toBe(true);
    await store.save(docId);
    expect(store.getInfo(docId).dirty).toBe(false);
    expect(readBg()).toBe('#333333');
  });

  it('removeDaemonInfo só remove do próprio pid quando onlyIfPid é dado', () => {
    const info = { port: 1, pid: 999999, startedAt: 'x', url: 'u', mcpUrl: 'm', wsUrl: 'w' };
    writeDaemonInfo(info, ws.dataDir);
    removeDaemonInfo(ws.dataDir, process.pid);
    expect(readDaemonInfo(ws.dataDir)?.pid).toBe(999999);
    removeDaemonInfo(ws.dataDir, 999999);
    expect(readDaemonInfo(ws.dataDir)).toBeNull();
    writeDaemonInfo(info, ws.dataDir);
    removeDaemonInfo(ws.dataDir);
    expect(readDaemonInfo(ws.dataDir)).toBeNull();
  });

  it('eventos doc:opened e doc:changed incluem history; save registra recente', async () => {
    const events: Array<{ canUndo: boolean; canRedo: boolean }> = [];
    store.on('doc:opened', (e) => events.push(e.history));
    store.on('doc:changed', (e) => events.push(e.history));
    const { docId } = await store.open(ws.file);
    bg(docId, '#111111');
    store.undo(docId, 'editor');
    expect(events).toEqual([
      { canUndo: false, canRedo: false },
      { canUndo: true, canRedo: false },
      { canUndo: false, canRedo: true },
    ]);
    fs.rmSync(path.join(ws.dataDir, 'recent.json'), { force: true });
    await store.save(docId);
    expect(readRecent(ws.dataDir)).toEqual([ws.file]);
  });

  it('saveAs grava no novo caminho, copia assets sem sobrescrever e atualiza o estado', async () => {
    const { docId } = await store.open(ws.file);
    const assets = path.join(ws.dir, 'assets');
    fs.mkdirSync(path.join(assets, 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'a.png'), 'novo');
    fs.writeFileSync(path.join(assets, 'fonts', 'f.woff2'), 'f');
    const destDir = path.join(ws.dir, 'outro');
    fs.mkdirSync(path.join(destDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(destDir, 'assets', 'a.png'), 'existente');
    bg(docId, '#222222');
    const saved: string[] = [];
    store.on('doc:saved', (e) => saved.push(e.path));
    const info = await store.saveAs(docId, path.join(destDir, 'copia'));
    const dest = path.join(destDir, 'copia.mockup.json');
    expect(info.path).toBe(dest);
    expect(info.dirty).toBe(false);
    expect(saved).toEqual([dest]);
    expect(
      parseDocument(fs.readFileSync(dest, 'utf8')).pages[0]!.frames[0]!.style['background'],
    ).toBe('#222222');
    expect(fs.readFileSync(path.join(destDir, 'assets', 'a.png'), 'utf8')).toBe('existente');
    expect(fs.existsSync(path.join(destDir, 'assets', 'fonts', 'f.woff2'))).toBe(true);
    expect(fs.existsSync(path.join(assets, 'a.png'))).toBe(true);
    expect(store.getInfo(docId).path).toBe(dest);
    expect(readRecent(ws.dataDir)[0]).toBe(dest);
    expect(store.assetsDir(docId)).toBe(path.join(destDir, 'assets'));
  });

  it('saveAs renomeia assets em colisão com conteúdo diferente e reescreve as referências', async () => {
    const { docId } = await store.open(ws.file);
    const assets = path.join(ws.dir, 'assets');
    fs.mkdirSync(path.join(assets, 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'a.png'), 'origem');
    fs.writeFileSync(path.join(assets, 'igual.png'), 'mesmo');
    fs.writeFileSync(path.join(assets, 'bg.png'), 'fundo');
    fs.writeFileSync(path.join(assets, 'fonts', 'f.woff2'), 'fonte');
    const destDir = path.join(ws.dir, 'outro');
    fs.mkdirSync(path.join(destDir, 'assets', 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(destDir, 'assets', 'a.png'), 'diferente');
    fs.writeFileSync(path.join(destDir, 'assets', 'igual.png'), 'mesmo');
    fs.writeFileSync(path.join(destDir, 'assets', 'bg.png'), 'outro-fundo');
    fs.writeFileSync(path.join(destDir, 'assets', 'fonts', 'f.woff2'), 'outra-fonte');
    const img = createNode({ tag: 'img', type: 'image', id: 'im_aaaaaaaa', name: 'Foto' });
    img.src = 'a.png';
    const same = createNode({ tag: 'img', type: 'image', id: 'im_bbbbbbbb', name: 'Igual' });
    same.src = 'igual.png';
    store.applyOps(
      docId,
      [
        { type: 'createNode', parentId: ws.frameId, node: img },
        { type: 'createNode', parentId: ws.frameId, node: same },
        {
          type: 'updateStyles',
          nodeIds: [ws.frameId],
          styles: { 'background-image': 'url("assets/bg.png")' },
        },
        {
          type: 'setFonts',
          fonts: [{ family: 'F', source: 'file', files: ['fonts/f.woff2'], weights: [400] }],
        },
      ],
      { source: 'mcp' },
    );
    const before = store.getRevision(docId);
    const changes: string[] = [];
    store.on('doc:changed', (e) => changes.push(e.source));
    await store.saveAs(docId, path.join(destDir, 'copia'));

    const out = path.join(destDir, 'assets');
    expect(fs.readFileSync(path.join(out, 'a.png'), 'utf8')).toBe('diferente');
    expect(fs.readFileSync(path.join(out, 'a-1.png'), 'utf8')).toBe('origem');
    expect(fs.existsSync(path.join(out, 'igual-1.png'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'fonts', 'f-1.woff2'), 'utf8')).toBe('fonte');
    const saved = parseDocument(fs.readFileSync(path.join(destDir, 'copia.mockup.json'), 'utf8'));
    const frame = saved.pages[0]!.frames[0]!;
    expect(frame.children.map((c) => c.src)).toEqual(['a-1.png', 'igual.png']);
    expect(frame.style['background-image']).toBe('url("assets/bg-1.png")');
    expect(saved.fonts[0]!.files).toEqual(['fonts/f-1.woff2']);
    // uma única entrada de histórico, com origem 'system'
    expect(changes).toEqual(['system']);
    expect(store.getRevision(docId)).toBe(before + 1);
    expect(store.getInfo(docId).dirty).toBe(false);
    store.undo(docId, 'editor');
    expect(store.get(docId).fonts[0]!.files).toEqual(['fonts/f.woff2']);
    expect(store.get(docId).pages[0]!.frames[0]!.children.map((c) => c.src)).toEqual([
      'a.png',
      'igual.png',
    ]);
  });

  it('saveAs recusa o caminho de outro documento aberto', async () => {
    const a = await store.open(ws.file);
    const b = await store.create(path.join(ws.dir, 'b'), 'B');
    await expect(store.saveAs(b.docId, ws.file)).rejects.toThrow(/outro documento aberto/);
    await expect(store.saveAs(a.docId, ws.file)).resolves.toMatchObject({ path: ws.file });
  });
});
