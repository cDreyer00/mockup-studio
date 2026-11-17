import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildPlaceholder } from './placeholder.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 32"><rect width="48" height="32"/></svg>';

describe('MCP: set_image e generate_placeholder', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = () => daemon.store.resolveDocId();
  const doc = () => daemon.store.get(docId());
  const frame = () => doc().pages[0]!.frames[0]!;
  const assets = () => path.join(ws.dir, 'assets');

  async function makeImage(): Promise<string> {
    const file = path.join(ws.dir, 'foto.svg');
    fs.writeFileSync(file, SVG);
    const r = await call('insert_image', { parentId: ws.frameId, source: file });
    expect(r.isError, textOf(r)).toBeFalsy();
    return frame().children[0]!.id;
  }
  const imgNode = () => frame().children[0]!;

  describe('set_image', () => {
    it('fit, posição por atalho, filtros mesclados (preserva drop-shadow), crop e clipPath', async () => {
      const id = await makeImage();
      await call('update_styles', {
        nodeIds: [id],
        styles: { filter: 'blur(2px) drop-shadow(0 0 2px rgba(0,0,0,.5))' },
      });
      const r = await call('set_image', {
        nodeId: id,
        fit: 'cover',
        position: 'top-left',
        filters: { grayscale: 100, blur: null, hueRotate: 30 },
        crop: { top: 10, bottom: 5 },
        clipPath: 'circle',
        alt: 'Foto',
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const s = imgNode().style;
      expect(s['object-fit']).toBe('cover');
      expect(s['object-position']).toBe('0% 0%');
      expect(s['filter']).toContain('grayscale(100%)');
      expect(s['filter']).toContain('hue-rotate(30deg)');
      expect(s['filter']).toContain('drop-shadow(0 0 2px rgba(0,0,0,.5))');
      expect(s['filter']).not.toContain('blur');
      expect(s['object-view-box']).toBe('inset(10% 0% 5% 0%)');
      expect(s['clip-path']).toBe('circle(50% at 50% 50%)');
      expect(imgNode().attrs['alt']).toBe('Foto');
      expect(textOf(r)).toContain('object-view-box');

      // remover: crop null, clipPath none, filtros neutros
      const r2 = await call('set_image', {
        nodeId: id,
        crop: null,
        clipPath: 'none',
        filters: { grayscale: null, 'hue-rotate': null },
      });
      expect(r2.isError, textOf(r2)).toBeFalsy();
      const s2 = imgNode().style;
      expect(s2['object-view-box']).toBeUndefined();
      expect(s2['clip-path']).toBeUndefined();
      expect(s2['filter']).toBe('drop-shadow(0 0 2px rgba(0,0,0,.5))');
    });

    it('clipPath com url() externa é recusado; url(#id) é aceito', async () => {
      const id = await makeImage();
      for (const bad of [
        'url(http://evil.test/x.svg#m)',
        "url( 'https://x.test/m' )",
        'url(m.svg)',
      ]) {
        const r = await call('set_image', { nodeId: id, clipPath: bad });
        expect(r.isError, bad).toBe(true);
        expect(textOf(r)).toContain('url(#id)');
      }
      expect(imgNode().style['clip-path']).toBeUndefined();
      const ok = await call('set_image', { nodeId: id, clipPath: 'url(#mascara)' });
      expect(ok.isError, textOf(ok)).toBeFalsy();
      expect(imgNode().style['clip-path']).toBe('url(#mascara)');
    });

    it('é uma única entrada de undo', async () => {
      const id = await makeImage();
      const before = JSON.stringify(imgNode());
      await call('set_image', {
        nodeId: id,
        fit: 'contain',
        filters: { sepia: 50 },
        crop: { left: 5 },
      });
      expect(imgNode().style['object-fit']).toBe('contain');
      await call('undo');
      expect(JSON.stringify(imgNode())).toBe(before);
    });

    it('source relativo (arquivo em assets/) e absoluto', async () => {
      const id = await makeImage();
      fs.writeFileSync(path.join(assets(), 'outra.svg'), SVG.replace('48', '60'));
      const r = await call('set_image', { nodeId: id, source: 'outra.svg' });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(imgNode().src).toBe('outra.svg');

      const abs = path.join(ws.dir, 'terceira.svg');
      fs.writeFileSync(abs, SVG.replace('48', '70'));
      const r2 = await call('set_image', { nodeId: id, source: abs });
      expect(r2.isError, textOf(r2)).toBeFalsy();
      expect(imgNode().src).toBe('terceira.svg');
      expect(fs.existsSync(path.join(assets(), 'terceira.svg'))).toBe(true);

      const miss = await call('set_image', { nodeId: id, source: 'nao-existe.png' });
      expect(miss.isError).toBe(true);
      expect(textOf(miss)).toContain('assets/');
    });

    it('erros: nó que não é imagem, nada para ajustar, filtro desconhecido', async () => {
      const id = await makeImage();
      const notImg = await call('set_image', { nodeId: ws.frameId, fit: 'cover' });
      expect(notImg.isError).toBe(true);
      expect(textOf(notImg)).toContain('não uma imagem');
      const none = await call('set_image', { nodeId: id });
      expect(none.isError).toBe(true);
      const bad = await call('set_image', { nodeId: id, filters: { sombra: 3 } });
      expect(bad.isError).toBe(true);
    });
  });

  describe('generate_placeholder', () => {
    it('contêiner ganha filho img; mesma seed = mesmo arquivo e bytes; seeds diferentes = arquivos diferentes', async () => {
      const r = await call('generate_placeholder', {
        nodeId: ws.frameId,
        kind: 'avatar',
        seed: 'ana',
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const img = frame().children[0]!;
      expect(img.type).toBe('image');
      expect(img.src).toMatch(/^placeholders\/avatar-ana-256x256\.svg$/);
      expect(img.style['width']).toBe('100%');
      expect(img.style['object-fit']).toBe('cover');
      expect(img.style['aspect-ratio']).toBe('256 / 256');
      const file = path.join(assets(), img.src!);
      const bytes = fs.readFileSync(file);

      const r2 = await call('generate_placeholder', {
        nodeId: ws.frameId,
        kind: 'avatar',
        seed: 'ana',
      });
      expect(r2.isError, textOf(r2)).toBeFalsy();
      const img2 = frame().children[1]!;
      expect(img2.src).toBe(img.src);
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect(fs.readdirSync(path.join(assets(), 'placeholders'))).toHaveLength(1);

      await call('generate_placeholder', { nodeId: img2.id, kind: 'avatar', seed: 'bia' });
      expect(frame().children[1]!.src).toBe('placeholders/avatar-bia-256x256.svg');
      expect(fs.readdirSync(path.join(assets(), 'placeholders'))).toHaveLength(2);
      const other = fs.readFileSync(path.join(assets(), 'placeholders', 'avatar-bia-256x256.svg'));
      expect(other.equals(bytes)).toBe(false);
    });

    it('nó image troca o src; nunca sobrescreve conteúdo diferente', async () => {
      const id = await makeImage();
      fs.mkdirSync(path.join(assets(), 'placeholders'), { recursive: true });
      fs.writeFileSync(path.join(assets(), 'placeholders', 'logo-x-480x160.svg'), 'meu arquivo');
      const r = await call('generate_placeholder', { nodeId: id, kind: 'logo', seed: 'x' });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(imgNode().src).toBe('placeholders/logo-x-480x160-1.svg');
      expect(
        fs.readFileSync(path.join(assets(), 'placeholders', 'logo-x-480x160.svg'), 'utf8'),
      ).toBe('meu arquivo');
    });

    it('erra em texto', async () => {
      await call('write_html', { parentId: ws.frameId, html: '<p>oi</p>' });
      const p = frame().children[0]!;
      const bad = await call('generate_placeholder', { nodeId: p.id, kind: 'avatar' });
      expect(bad.isError).toBe(true);
    });

    it('documento sem caminho usa data URL', async () => {
      const r = await buildPlaceholder(doc(), null, {
        nodeId: ws.frameId,
        kind: 'logo',
        seed: 'a',
      });
      expect(r.src.startsWith('data:image/svg+xml')).toBe(true);
      expect(r.ops[0]!.type).toBe('createNode');
    });

    it('rota HTTP /api/placeholder grava e aplica o src', async () => {
      const id = await makeImage();
      const res = await fetch(`${daemon.url}/api/placeholder/${docId()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: id, kind: 'product', seed: '7', width: 300, height: 200 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { src: string; nodeId: string };
      expect(body.nodeId).toBe(id);
      expect(body.src).toBe('placeholders/product-7-300x200.svg');
      expect(imgNode().src).toBe(body.src);
      expect(fs.existsSync(path.join(assets(), body.src))).toBe(true);
      const bad = await fetch(`${daemon.url}/api/placeholder/${docId()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: id, kind: 'gato' }),
      });
      expect(bad.status).toBe(400);
    });
  });
});
