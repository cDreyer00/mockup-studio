import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { detectImage, writeAsset } from './assets.js';
import {
  googleCssUrl,
  guessFontStyle,
  parseFcList,
  parseGoogleCss,
  parseRegFonts,
  splitFamilyStyle,
} from './fonts.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
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

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 32"><rect width="48" height="32"/></svg>';

describe('assets e fontes (unidades)', () => {
  it('detectImage lê tipo e dimensões', () => {
    expect(detectImage(fakePng(30, 20))).toMatchObject({ ext: '.png', width: 30, height: 20 });
    expect(detectImage(Buffer.from(SVG))).toMatchObject({ ext: '.svg', width: 48, height: 32 });
    expect(detectImage(Buffer.from('GIF89a\x0a\x00\x14\x00', 'latin1'))).toMatchObject({
      ext: '.gif',
      width: 10,
      height: 20,
    });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x32,
      0x00, 0x64, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(detectImage(jpeg)).toMatchObject({ ext: '.jpg', width: 100, height: 50 });
    expect(detectImage(Buffer.from('texto qualquer'))).toBeNull();
  });

  it('writeAsset não sobrescreve e acrescenta sufixo', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env['TEMP'] ?? '/tmp'), 'wa-'));
    try {
      expect(await writeAsset(dir, 'a.png', Buffer.from('1'))).toBe('a.png');
      expect(await writeAsset(dir, 'a.png', Buffer.from('2'))).toBe('a-1.png');
      expect(await writeAsset(dir, 'a.png', Buffer.from('3'))).toBe('a-2.png');
      expect(fs.readFileSync(path.join(dir, 'a.png'), 'utf8')).toBe('1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseGoogleCss pega os blocos latin de cada peso', () => {
    const css = `/* latin-ext */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/inter/ext400.woff2) format('woff2');
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/inter/lat400.woff2) format('woff2');
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: italic;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/inter/lat700i.woff2) format('woff2');
}`;
    const faces = parseGoogleCss(css).filter((f) => f.subset === 'latin');
    expect(faces).toEqual([
      {
        subset: 'latin',
        style: 'normal',
        weight: 400,
        url: 'https://fonts.gstatic.com/s/inter/lat400.woff2',
      },
      {
        subset: 'latin',
        style: 'italic',
        weight: 700,
        url: 'https://fonts.gstatic.com/s/inter/lat700i.woff2',
      },
    ]);
    expect(googleCssUrl('Playfair Display', [700, 400])).toBe(
      'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
    );
  });

  it('parsers de fontes do sistema agrupam famílias', () => {
    const reg = [
      '    Arial (TrueType)    REG_SZ    arial.ttf',
      '    Arial Bold Italic (TrueType)    REG_SZ    arialbi.ttf',
      '    Cambria & Cambria Math (TrueType)    REG_SZ    cambria.ttc',
      '    Segoe UI Semibold (TrueType)    REG_SZ    seguisb.ttf',
    ].join('\r\n');
    const fonts = parseRegFonts(reg);
    const arial = fonts.find((f) => f.family === 'Arial')!;
    expect(arial.styles).toEqual(['Regular', 'Bold Italic']);
    expect(fonts.map((f) => f.family)).toEqual(['Arial', 'Cambria', 'Cambria Math', 'Segoe UI']);
    expect(splitFamilyStyle('Roboto Light Italic')).toEqual({
      family: 'Roboto',
      style: 'Light Italic',
    });
    expect(parseFcList('DejaVu Sans,DejaVu Sans Book\tBook\t/usr/share/DejaVuSans.ttf')).toEqual([
      { family: 'DejaVu Sans', styles: ['Book'], files: ['/usr/share/DejaVuSans.ttf'] },
    ]);
    expect(guessFontStyle('Inter-SemiBoldItalic.woff2')).toEqual({ weight: 600, style: 'italic' });
  });
});

describe('MCP imagens, ícones e fontes', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let server: http.Server | undefined;

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
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const doc = () => daemon.store.get(daemon.store.resolveDocId());
  const frame = () => doc().pages[0]!.frames[0]!;

  const serve = async (routes: Record<string, { type: string; body: Buffer }>): Promise<string> => {
    server = http.createServer((req, res) => {
      const r = routes[req.url ?? ''];
      if (!r) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': r.type }).end(r.body);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  describe('insert_image', () => {
    it('caminho local: copia para assets/, cria o nó e usa o tamanho intrínseco', async () => {
      const file = path.join(ws.dir, 'Minha Foto.png');
      fs.writeFileSync(file, fakePng(30, 20));
      const r = await call('insert_image', { parentId: ws.frameId, source: file, alt: 'Foto' });
      expect(r.isError, textOf(r)).toBeFalsy();
      const img = frame().children[0]!;
      expect(img.type).toBe('image');
      expect(img.src).toBe('Minha-Foto.png');
      expect(img.attrs['alt']).toBe('Foto');
      expect(img.style['width']).toBe('30px');
      expect(img.style['height']).toBe('20px');
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'Minha-Foto.png'))).toBe(true);
      expect(textOf(r)).toContain(img.id);

      await call('insert_image', {
        parentId: ws.frameId,
        source: file,
        styles: { width: '100px' },
      });
      const second = frame().children[1]!;
      expect(second.src).toBe('Minha-Foto-1.png');
      expect(second.style['width']).toBe('100px');
      expect(second.style['height']).toBeUndefined();
    });

    it('data URL, SVG e índice', async () => {
      const url = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;
      await call('insert_image', { parentId: ws.frameId, source: url, name: 'Logo' });
      await call('insert_image', { parentId: ws.frameId, source: url, index: 0, name: 'Primeiro' });
      const kids = frame().children;
      expect(kids.map((k) => k.name)).toEqual(['Primeiro', 'Logo']);
      expect(kids[0]!.src).toMatch(/\.svg$/);
      expect(kids[0]!.style['width']).toBe('48px');
    });

    it('URL http com servidor local; recusa não-imagem', async () => {
      const base = await serve({
        '/a.png': { type: 'image/png', body: fakePng(8, 6) },
        '/pagina': { type: 'text/html', body: Buffer.from('<html></html>') },
        '/falso.png': { type: 'image/png', body: Buffer.from('não sou imagem') },
      });
      const ok = await call('insert_image', { parentId: ws.frameId, source: `${base}/a.png` });
      expect(ok.isError, textOf(ok)).toBeFalsy();
      expect(frame().children[0]!.src).toBe('a.png');
      const html = await call('insert_image', { parentId: ws.frameId, source: `${base}/pagina` });
      expect(html.isError).toBe(true);
      expect(textOf(html)).toContain('text/html');
      const fake = await call('insert_image', {
        parentId: ws.frameId,
        source: `${base}/falso.png`,
      });
      expect(fake.isError).toBe(true);
      expect(textOf(fake)).toContain('não é uma imagem');
    });

    it('erros: arquivo inexistente e caminho relativo', async () => {
      const a = await call('insert_image', {
        parentId: ws.frameId,
        source: path.join(ws.dir, 'nao-existe.png'),
      });
      expect(a.isError).toBe(true);
      const b = await call('insert_image', { parentId: ws.frameId, source: 'relativo.png' });
      expect(b.isError).toBe(true);
      expect(textOf(b)).toContain('absoluto');
    });
  });

  describe('ícones', () => {
    it('insert_icon cria nó svg com cor resolvida do pai e tamanho', async () => {
      await call('update_styles', { nodeIds: [ws.frameId], styles: { color: '#336699' } });
      const r = await call('insert_icon', { parentId: ws.frameId, name: 'ArrowRight', size: 32 });
      expect(r.isError, textOf(r)).toBeFalsy();
      const n = frame().children[0]!;
      expect(n.type).toBe('svg');
      expect(n.svg).toContain('stroke="#336699"');
      expect(n.svg).toContain('width="32"');
      expect(n.svg).not.toContain('currentColor');
      expect(n.style['width']).toBe('32px');
      expect(n.name).toBe('Ícone arrow-right');
    });

    it('insert_icon com cor, traço, fallback e nome inexistente', async () => {
      await call('insert_icon', {
        parentId: ws.frameId,
        name: 'search',
        color: '#ff0000',
        stroke_width: 1.5,
      });
      expect(frame().children[0]!.svg).toContain('stroke="#ff0000"');
      expect(frame().children[0]!.svg).toContain('stroke-width="1.5"');
      await call('insert_icon', { parentId: ws.frameId, name: 'user' });
      expect(frame().children[1]!.svg).toContain('stroke="#111111"');
      const bad = await call('insert_icon', { parentId: ws.frameId, name: 'arrow-rigth' });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('arrow-right');
    });

    it('search_icons busca por nome e tag', async () => {
      const r = textOf(await call('search_icons', { query: 'arrow-right', limit: 5 }));
      expect(r.split('\n')[1]).toContain('arrow-right');
      const byTag = textOf(await call('search_icons', { query: 'magnifier' }));
      expect(byTag).toContain('search');
      expect(textOf(await call('search_icons', { query: 'zzzzqqq' }))).toContain('Nenhum');
    });
  });

  describe('fontes', () => {
    it('add_font com arquivo local grava em assets/fonts, registra e desfaz', async () => {
      const file = path.join(ws.dir, 'Inter-Bold.woff2');
      fs.writeFileSync(file, Buffer.from('falso'));
      const r = await call('add_font', { family: 'Inter', source: file });
      expect(r.isError, textOf(r)).toBeFalsy();
      const [font] = doc().fonts;
      expect(font).toMatchObject({
        family: 'Inter',
        source: 'file',
        weights: [700],
        styles: ['normal'],
      });
      expect(font!.files).toEqual([
        expect.stringMatching(/^fonts[/]inter-700-normal-[0-9a-f]{8}[.]woff2$/),
      ]);
      expect(fs.existsSync(path.join(ws.dir, 'assets', font!.files![0]!))).toBe(true);
      expect(textOf(r)).toContain('font-family: "Inter", sans-serif');
      await call('undo');
      expect(doc().fonts).toEqual([]);
    });

    it('add_font com pasta e filtro de pesos; re-adicionar substitui a família', async () => {
      const dir = path.join(ws.dir, 'familia');
      fs.mkdirSync(dir);
      for (const f of ['Lora-Regular.ttf', 'Lora-Bold.ttf', 'Lora-BoldItalic.ttf'])
        fs.writeFileSync(path.join(dir, f), 'x');
      await call('add_font', { family: 'Lora', source: dir });
      expect(doc().fonts[0]!.files).toHaveLength(3);
      expect(doc().fonts[0]!.styles).toContain('italic');
      await call('add_font', { family: 'lora', source: dir, weights: [400] });
      expect(doc().fonts).toHaveLength(1);
      expect(doc().fonts[0]!.weights).toEqual([400]);
    });

    it('add_font por URL local; erros de extensão e sem caminho', async () => {
      const base = await serve({
        '/Foo-Light.woff': { type: 'font/woff', body: Buffer.from('w') },
      });
      const r = await call('add_font', { family: 'Foo', source: `${base}/Foo-Light.woff` });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(doc().fonts[0]).toMatchObject({ weights: [300] });
      expect(doc().fonts[0]!.files![0]).toMatch(/^fonts[/]foo-300-normal-[0-9a-f]{8}[.]woff$/);
      const bad = await call('add_font', { family: 'Foo', source: `${base}/x.exe` });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('arquivo de fonte');
    });

    it('add_font: nome único pelo conteúdo, sem sobrescrever; re-adicionar troca a entrada no lugar', async () => {
      const file = path.join(ws.dir, 'Inter-Regular.woff2');
      fs.writeFileSync(file, 'versao-1');
      await call('add_font', { family: 'Inter', source: file });
      await call('add_font', { family: 'Arial', source: 'local' });
      const v1 = doc().fonts[0]!.files![0]!;
      fs.writeFileSync(file, 'versao-2');
      await call('add_font', { family: 'Inter', source: file });
      const v2 = doc().fonts[0]!.files![0]!;
      expect(doc().fonts.map((f) => f.family)).toEqual(['Inter', 'Arial']);
      expect(v2).not.toBe(v1);
      const fontsDir = path.join(ws.dir, 'assets', 'fonts');
      expect(fs.readFileSync(path.join(ws.dir, 'assets', v1), 'utf8')).toBe('versao-1');
      expect(fs.readdirSync(fontsDir)).toHaveLength(2);
      // mesmo conteúdo reaproveita o arquivo
      await call('add_font', { family: 'Inter', source: file });
      expect(doc().fonts[0]!.files![0]).toBe(v2);
      expect(fs.readdirSync(fontsDir)).toHaveLength(2);
      await call('undo');
      await call('undo');
      expect(doc().fonts[0]!.files![0]).toBe(v1);
    });

    it('add_font com pasta: um arquivo por peso/estilo, preferindo woff2 > woff > ttf', async () => {
      const dir = path.join(ws.dir, 'multi');
      fs.mkdirSync(dir);
      for (const f of ['Kai-Regular.ttf', 'Kai-Regular.woff', 'Kai-Regular.woff2', 'Kai-Bold.ttf'])
        fs.writeFileSync(path.join(dir, f), f);
      await call('add_font', { family: 'Kai', source: dir });
      const font = doc().fonts[0]!;
      expect(font.weights).toEqual([400, 700]);
      expect(font.files![0]).toMatch(/kai-400-normal-[0-9a-f]{8}[.]woff2$/);
      expect(font.files![1]).toMatch(/kai-700-normal-[0-9a-f]{8}[.]ttf$/);
    });

    it('add_font: famílias com o mesmo slug ganham sufixo e não se misturam', async () => {
      const a = path.join(ws.dir, 'a');
      const b = path.join(ws.dir, 'b');
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      fs.writeFileSync(path.join(a, 'X-Regular.woff2'), 'A');
      fs.writeFileSync(path.join(b, 'X-Regular.woff2'), 'B');
      await call('add_font', { family: 'Foo Bar', source: path.join(a, 'X-Regular.woff2') });
      await call('add_font', { family: 'Foo-Bar!', source: path.join(b, 'X-Regular.woff2') });
      const [f1, f2] = doc().fonts;
      expect(f1!.files![0]).toMatch(/^fonts[/]foo-bar-400-/);
      expect(f2!.files![0]).toMatch(/^fonts[/]foo-bar-[0-9a-f]{4}-400-/);
      expect(f2!.files![0]).not.toBe(f1!.files![0]);
    });

    it('add_font local só registra', async () => {
      const r = await call('add_font', { family: 'Arial', source: 'local' });
      expect(r.isError).toBeFalsy();
      expect(doc().fonts).toEqual([{ family: 'Arial', source: 'local' }]);
    });

    it('list_fonts e get_font_info', async () => {
      const file = path.join(ws.dir, 'Zeta-Regular.woff2');
      fs.writeFileSync(file, 'x');
      await call('add_font', { family: 'Zeta Sans', source: file });
      const list = textOf(await call('list_fonts', { query: 'zeta' }));
      expect(list).toContain('Zeta Sans [embutida]');
      const info = textOf(await call('get_font_info', { family: 'Zeta Sans' }));
      expect(info).toContain('Documento: embutida');
      expect(info).toMatch(/fonts[/]zeta-sans-400-normal-[0-9a-f]{8}[.]woff2/);
      expect(info).toContain('font-family: "Zeta Sans", sans-serif');
      const all = textOf(await call('list_fonts', { limit: 5 }));
      expect(all).toContain('No sistema');
    });

    it.skipIf(process.platform !== 'win32')(
      'list_fonts devolve fontes do sistema no Windows',
      async () => {
        const list = textOf(await call('list_fonts', { query: 'arial' }));
        expect(list).toMatch(/- Arial/);
        const info = textOf(await call('get_font_info', { family: 'Arial' }));
        expect(info).toContain('Sistema: instalada');
      },
    );
  });
});
