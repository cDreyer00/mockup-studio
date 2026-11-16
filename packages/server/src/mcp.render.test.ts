import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LayoutNode } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { RENDER_UNAVAILABLE, type CaptureRequest, type RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
type Content = { type: string; text?: string; data?: string; mimeType?: string };

const contentOf = (r: unknown): Content[] => (r as { content: Content[] }).content;
const textOf = (r: unknown): string =>
  contentOf(r)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** PNG válido (IHDR com as dimensões pedidas, pixels transparentes). */
function fakePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('MCP render, export e guias', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];

  const render: RenderProvider = {
    async capture(req) {
      captures.push(req);
      const scale = req.scale ?? 1;
      const pixelWidth = Math.min(160 * scale, req.maxWidth ?? Infinity);
      const pixelHeight = Math.round((pixelWidth * 90) / 160);
      const jpg = req.format === 'jpg';
      return {
        data: jpg ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : fakePng(pixelWidth, pixelHeight),
        mime: jpg ? 'image/jpeg' : 'image/png',
        width: 1440,
        height: 900,
        pixelWidth,
        pixelHeight,
      };
    },
    async measure({ nodeId }): Promise<LayoutNode> {
      const style = {};
      return {
        id: nodeId,
        name: 'Desktop',
        type: 'frame',
        tag: 'div',
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        style,
        children: [
          {
            id: 'el_head',
            name: 'Cabeçalho',
            type: 'element',
            tag: 'header',
            x: 0,
            y: 0,
            width: 1440,
            height: 80.4,
            style,
            children: [
              {
                id: 'tx_title',
                name: 'Título',
                type: 'text',
                tag: 'h1',
                x: 24,
                y: 20,
                width: 200,
                height: 40,
                style,
                lines: [
                  { text: 'Olá', x: 24, y: 20, width: 40, height: 40, baseline: 30 },
                  { text: 'mundo', x: 24, y: 60, width: 80, height: 40, baseline: 30 },
                ],
                children: [],
              },
              {
                id: 'el_deep',
                name: 'Fundo',
                type: 'element',
                tag: 'div',
                x: 0,
                y: 0,
                width: 10,
                height: 10,
                style,
                children: [
                  {
                    id: 'el_x',
                    name: 'X',
                    type: 'element',
                    tag: 'div',
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    style,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      };
    },
  };

  const start = async (withRender: boolean) => {
    ws = makeWorkspace();
    captures = [];
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      render: withRender ? render : undefined,
    });
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  };
  const stop = async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  describe('com render', () => {
    beforeEach(() => start(true));
    afterEach(stop);

    it('get_screenshot devolve imagem base64 e texto com tamanhos', async () => {
      const r = await call('get_screenshot', { nodeId: ws.frameId });
      expect(r.isError).toBeFalsy();
      const [img, txt] = contentOf(r);
      expect(img!.type).toBe('image');
      expect(img!.mimeType).toBe('image/png');
      const bytes = Buffer.from(img!.data!, 'base64');
      expect(bytes.readUInt32BE(16)).toBe(160);
      expect(txt!.text).toMatch(
        new RegExp(`^${ws.frameId} "Desktop": 1440x900 px \\(imagem 160x90 png, \\d+ KB\\)$`),
      );
      expect(captures[0]).toMatchObject({ scale: 1, format: 'png', nodeId: ws.frameId });
    });

    it('sem nodeId usa a seleção e, sem seleção, o primeiro frame; repassa scale e format', async () => {
      await call('get_screenshot');
      expect(captures[0]!.nodeId).toBe(ws.frameId);

      const child = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Caixa' });
      const id = /(el_[0-9a-z]+)/.exec(textOf(child))![1]!;
      await call('set_selection', { nodeIds: [id] });
      const r = await call('get_screenshot', { scale: 2, format: 'jpg', maxWidth: 200 });
      expect(captures[1]).toMatchObject({ nodeId: id, scale: 2, format: 'jpg', maxWidth: 200 });
      expect(contentOf(r)[0]!.mimeType).toBe('image/jpeg');
      expect(textOf(r)).toContain('jpg');
    });

    it('get_screenshot com nó inexistente dá erro útil', async () => {
      const r = await call('get_screenshot', { nodeId: 'el_naoexiste' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('get_tree_summary');
    });

    it('get_layout formata uma linha por nó e colapsa além da profundidade', async () => {
      const r = await call('get_layout', { nodeId: ws.frameId, depth: 1 });
      const t = textOf(r);
      expect(t).toContain(`${ws.frameId} "Desktop" div 0,0 1440x900`);
      expect(t).toContain('  el_head "Cabeçalho" header 0,0 1440x80');
      expect(t).toContain('2 filho(s)');
      expect(t).not.toContain('tx_title');

      const full = textOf(await call('get_layout', { nodeId: ws.frameId, depth: 2 }));
      expect(full).toContain('    tx_title "Título" h1 24,20 200x40 "Olá mundo"');
      expect(full).toContain('      … 1 filho(s)');
    });

    it('export png e jpg gravam arquivos com o slug do nó', async () => {
      const out = path.join(ws.dir, 'saida');
      const r = await call('export', { nodeIds: [ws.frameId], format: 'png', outputDir: out });
      expect(r.isError).toBeFalsy();
      expect(fs.existsSync(path.join(out, 'desktop.png'))).toBe(true);
      expect(textOf(r)).toContain('desktop.png');
      await call('export', { nodeIds: [ws.frameId], format: 'jpg', outputDir: out, scale: 2 });
      expect(fs.existsSync(path.join(out, 'desktop.jpg'))).toBe(true);
      expect(captures[1]).toMatchObject({ scale: 2, format: 'jpg' });
    });

    it('export usa <pasta do documento>/exports por padrão', async () => {
      await call('export', { nodeIds: [ws.frameId], format: 'png' });
      expect(fs.existsSync(path.join(ws.dir, 'exports', 'desktop.png'))).toBe(true);
    });

    it('export rejeita outputDir relativo', async () => {
      const r = await call('export', { nodeIds: [ws.frameId], format: 'png', outputDir: 'rel' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('absoluto');
    });

    it('finish_working emite agent:finished', async () => {
      const seen: { docId: string; nodeIds: string[] }[] = [];
      daemon.store.on('agent:finished', (e) => seen.push(e));
      const r = await call('finish_working', { nodeIds: [ws.frameId] });
      expect(r.isError).toBeFalsy();
      expect(seen).toHaveLength(1);
      expect(seen[0]!.nodeIds).toEqual([ws.frameId]);
      await call('finish_working');
      expect(seen[1]!.nodeIds).toEqual([]);
    });
  });

  describe('exportadores de código (dependem do core)', () => {
    beforeEach(() => start(true));
    afterEach(stop);

    const prepare = async () => {
      await call('write_html', {
        html: '<section class="hero"><h1>Olá</h1><p>Texto</p></section>',
        css: '.hero{display:flex;gap:16px;padding:24px}',
        parentId: ws.frameId,
      });
    };

    it('export svg grava o arquivo', async () => {
      await prepare();
      const out = path.join(ws.dir, 'svg');
      const r = await call('export', { nodeIds: [ws.frameId], format: 'svg', outputDir: out });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(fs.readFileSync(path.join(out, 'desktop.svg'), 'utf8')).toContain('<svg');
    });

    it('export svg embute as fontes registradas em doc.fonts como data URL', async () => {
      await prepare();
      fs.mkdirSync(path.join(ws.dir, 'assets', 'fonts'), { recursive: true });
      fs.writeFileSync(path.join(ws.dir, 'assets', 'fonts', 'x.woff2'), 'bytes-falsos');
      daemon.store.applyOps(
        daemon.store.resolveDocId(undefined),
        [
          {
            type: 'setFonts',
            fonts: [{ family: 'Xis', source: 'file', files: ['fonts/x.woff2'], weights: [400] }],
          },
        ],
        { source: 'mcp' },
      );
      const out = path.join(ws.dir, 'svg-fonte');
      const r = await call('export', { nodeIds: [ws.frameId], format: 'svg', outputDir: out });
      expect(r.isError, textOf(r)).toBeFalsy();
      const svg = fs.readFileSync(path.join(out, 'desktop.svg'), 'utf8');
      expect(svg).toContain('@font-face');
      expect(svg).toContain(
        'data:font/woff2;base64,' + Buffer.from('bytes-falsos').toString('base64'),
      );
    });

    it('export html e tailwind gravam arquivos e copiam assets usados', async () => {
      await prepare();
      fs.writeFileSync(path.join(ws.dir, 'foto.png'), fakePng(4, 4));
      await call('insert_image', {
        parentId: ws.frameId,
        source: path.join(ws.dir, 'foto.png'),
      });
      const out = path.join(ws.dir, 'codigo');
      const h = await call('export', { nodeIds: [ws.frameId], format: 'html', outputDir: out });
      expect(h.isError, textOf(h)).toBeFalsy();
      expect(fs.readFileSync(path.join(out, 'desktop.html'), 'utf8')).toContain('Olá');
      expect(fs.existsSync(path.join(out, 'assets', 'foto.png'))).toBe(true);
      const t = await call('export', { nodeIds: [ws.frameId], format: 'tailwind', outputDir: out });
      expect(t.isError, textOf(t)).toBeFalsy();
      expect(fs.readFileSync(path.join(out, 'desktop.tailwind.html'), 'utf8')).toContain('Olá');
    });

    it('export react grava o componente', async () => {
      await prepare();
      const out = path.join(ws.dir, 'react');
      const r = await call('export', {
        nodeIds: [ws.frameId],
        format: 'react',
        outputDir: out,
        styles: 'inline',
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(fs.readFileSync(path.join(out, 'Desktop.tsx'), 'utf8')).toContain('Desktop');
    });

    it.each(['html', 'tailwind', 'react'] as const)('get_code %s', async (format) => {
      await prepare();
      const r = await call('get_code', { nodeId: ws.frameId, format });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(textOf(r)).toContain('Olá');
    });
  });

  describe('sem render', () => {
    beforeEach(() => start(false));
    afterEach(stop);

    it('screenshot, layout e export png dão isError com a mensagem de render', async () => {
      for (const [name, args] of [
        ['get_screenshot', {}],
        ['get_layout', { nodeId: ws.frameId }],
        ['export', { nodeIds: [ws.frameId], format: 'png', outputDir: path.join(ws.dir, 'o') }],
      ] as const) {
        const r = await call(name, args);
        expect(r.isError, name).toBe(true);
        expect(textOf(r)).toContain(RENDER_UNAVAILABLE);
      }
    });
  });

  describe('guias e tokens', () => {
    beforeEach(() => start(false));
    afterEach(stop);

    it('get_guide dos novos tópicos e resources', async () => {
      const a = textOf(await call('get_guide', { topic: 'screenshot-loop' }));
      expect(a).toContain('get_screenshot');
      expect(a).toContain('finish_working');
      const b = textOf(await call('get_guide', { topic: 'export' }));
      expect(b).toContain('outputDir');
      expect(textOf(await call('get_guide', { topic: 'getting-started' }))).toContain(
        'get_screenshot',
      );
      const { resources } = await client.listResources();
      const uris = resources.map((x) => x.uri);
      expect(uris).toContain('guide://screenshot-loop');
      expect(uris).toContain('guide://export');
      const res = await client.readResource({ uri: 'guide://export' });
      expect((res.contents[0] as { text: string }).text).toContain('get_code');
    });

    it('set_tokens acrescenta o prefixo -- automaticamente', async () => {
      const r = await call('set_tokens', { tokens: { primary: '#6c5ce7', '--gap': '8px' } });
      expect(r.isError).toBeFalsy();
      const t = textOf(await call('get_tokens'));
      expect(t).toContain('--primary: #6c5ce7');
      expect(t).toContain('--gap: 8px');
      await call('set_tokens', { tokens: {}, unset: ['primary'] });
      expect(textOf(await call('get_tokens'))).not.toContain('--primary');
    });

    it('lista as ferramentas novas', async () => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of [
        'get_screenshot',
        'get_layout',
        'export',
        'get_code',
        'insert_image',
        'insert_icon',
        'search_icons',
        'list_fonts',
        'get_font_info',
        'add_font',
        'finish_working',
      ]) {
        expect(names).toContain(n);
      }
    });
  });
});
