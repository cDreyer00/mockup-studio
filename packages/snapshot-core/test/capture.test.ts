import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { NodeSchema, type Node } from '@mockup/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CaptureOptions } from '../src/browser.js';
import type { SnapshotPayload } from '../src/format.js';

type MockupApi = {
  captureSelector: (selector: string, opts?: CaptureOptions) => Promise<SnapshotPayload>;
};

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '../..');
const fixtures = path.join(pkgRoot, 'test', 'fixtures');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

let server: http.Server;
let base = '';
let browser: Browser;
let page: Page;
let bundle = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.join(fixtures, decodeURIComponent(url.pathname));
    if (url.pathname === '/vendor/lucide.woff2') {
      file = path.join(repoRoot, 'node_modules', 'lucide-static', 'font', 'lucide.woff2');
    } else if (!file.startsWith(fixtures)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // In-memory bundle (does not depend on dist).
  const result = await build({
    entryPoints: [path.join(pkgRoot, 'src', 'iife.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    write: false,
    absWorkingDir: pkgRoot,
  });
  bundle = result.outputFiles[0]!.text;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
}, 120000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

async function open(pathname: string): Promise<void> {
  await page.goto(`${base}${pathname}`, { waitUntil: 'load' });
  await page.addScriptTag({ content: bundle });
}

function capture(selector: string, opts: CaptureOptions = {}): Promise<SnapshotPayload> {
  return page.evaluate(
    ([s, o]) =>
      (globalThis as unknown as { MockupSnapshot: MockupApi }).MockupSnapshot.captureSelector(s, o),
    [selector, opts] as [string, CaptureOptions],
  ) as Promise<SnapshotPayload>;
}

function walk(node: Node, fn: (n: Node, depth: number) => void, depth = 0): void {
  fn(node, depth);
  for (const c of node.children) walk(c, fn, depth + 1);
}
function find(node: Node, pred: (n: Node) => boolean): Node | undefined {
  let found: Node | undefined;
  walk(node, (n) => {
    if (!found && pred(n)) found = n;
  });
  return found;
}
const all = (node: Node): Node[] => {
  const list: Node[] = [];
  walk(node, (n) => list.push(n));
  return list;
};
/** Text of a node or of its first child (span inside inline). */
const textOf = (n: Node): string | undefined => n.text ?? n.children[0]?.text;

describe('landing capture', () => {
  beforeAll(() => open('/landing/'));

  it('captures the header: structure, texts and root', async () => {
    const snap = await capture('.site-header');
    expect(snap.format).toBe('mockup-snapshot');
    expect(snap.source.selector).toBe('.site-header');
    expect(snap.source.viewport).toEqual({ width: 1440, height: 900 });
    expect(snap.source.url).toBe(`${base}/landing/`);
    const root = snap.root;
    expect(root.type).toBe('element');
    expect(root.tag).toBe('header');
    expect(root.name).toBe('Site-header');
    expect(root.style['position']).toBe('relative');
    expect(root.style['width']).toBe('1440px');
    expect(root.style['height']).toMatch(/^\d+(\.\d+)?px$/);
    expect(snap.width).toBe(1440);
    expect(root.style['display']).toBe('flex');
    expect(root.style['padding']).toBe('16px 48px');
    // Inherited typography explicit on the root.
    expect(root.style['color']).toBe('rgb(31, 41, 55)');
    expect(root.style['font-family']).toContain('Arial');
    expect(root.style['margin']).toBeUndefined();

    const nav = find(root, (n) => n.tag === 'nav')!;
    expect(nav).toBeDefined();
    const links = nav.children.filter((n) => n.tag === 'a');
    expect(links.map((l) => l.text)).toEqual(['Product', 'Pricing', 'Contact']);
    expect(links[0]!.attrs['href']).toBe(`${base}/landing/#product`);
    const button = nav.children.find((n) => n.tag === 'button')!;
    expect(button.text).toBe('Sign in');
    expect(button.attrs['type']).toBe('button');
    expect(button.style['letter-spacing']).toBe('0.2px');
    expect(button.style['border-radius']).toBe('8px');
    expect(button.style['border']).toBe('1px solid rgb(79, 70, 229)');
  });

  it('images become assets with a data URL', async () => {
    const snap = await capture('.site-header');
    const img = find(snap.root, (n) => n.tag === 'img')!;
    expect(img.type).toBe('image');
    expect(img.src).toMatch(/^asset:a\d+$/);
    expect(img.attrs['alt']).toBe('Aurora');
    const asset = snap.assets.find((a) => `asset:${a.id}` === img.src)!;
    expect(asset.kind).toBe('image');
    expect(asset.url).toBe(`${base}/landing/logo.svg`);
    expect(asset.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(asset.mime).toBe('image/svg+xml');
    expect(img.style['width']).toBe('120px');
    expect(img.style['height']).toBe('32px');
  });

  it('captures the hero: gradient, pseudo-elements and shadow', async () => {
    const snap = await capture('.hero');
    const root = snap.root;
    expect(root.style['background-image']).toContain('linear-gradient');
    expect(root.style['background-color']).toBe('rgb(249, 250, 251)'); // comes from the body
    expect(snap.height).toBeGreaterThan(300);

    const h1 = find(root, (n) => n.tag === 'h1')!;
    expect(h1.style['font-size']).toBe('56px');
    expect(h1.style['margin']).toBeUndefined();
    expect(h1.style['margin-bottom']).toBe('16px');
    // Mixed text: runs become spans, <em> becomes a child.
    expect(h1.text).toBeUndefined();
    expect(h1.children.map(textOf)).toEqual(['Design with ', 'HTML', ' for real']);
    expect(find(h1, (n) => n.tag === 'em')?.style).toEqual({}); // italic already comes from the UA

    const btn = find(root, (n) => n.tag === 'a' && n.name === 'Btn')!;
    expect(btn.style['box-shadow']).toContain('rgba(79, 70, 229, 0.35)');
    expect(btn.style['border-radius']).toBe('999px');
    expect(btn.style['display']).toBe('inline-flex');
    const kids = btn.children;
    expect(kids.map((k) => k.name)).toEqual(['::before', 'Get started', '::after']);
    expect(kids[0]!.style['width']).toBe('10px');
    expect(kids[0]!.style['border-radius']).toBe('50%');
    expect(kids[0]!.style['display']).toBeUndefined(); // div: block is the default
    expect(kids[1]!.text).toBe('Get started');
    expect(kids[2]!.text).toBe('→');

    const hero = find(root, (n) => n.type === 'image')!;
    expect(hero.style['width']).toBe('480px');
    expect(hero.style['height']).toBe('320px');
    expect(snap.assets.find((a) => `asset:${a.id}` === hero.src)?.dataUrl).toBeTruthy();
  });

  it('reduces styles: no user agent defaults or base CSS', async () => {
    const snap = await capture('.hero');
    const copy = find(snap.root, (n) => n.name === 'Hero-copy')!;
    expect(copy.style['display']).toBeUndefined(); // block is the default of div
    expect(copy.style['margin']).toBeUndefined();
    expect(copy.style['box-sizing']).toBeUndefined();
    expect(copy.style['width']).toBe('640px');
    const p = find(snap.root, (n) => n.tag === 'p')!;
    expect(p.style['font-size']).toBe('20px');
    expect(p.style['font-family']).toBeUndefined(); // same as the parent
    for (const n of all(snap.root)) {
      expect(n.attrs['style']).toBeUndefined();
      expect(n.attrs['class']).toBeUndefined();
      expect(n.attrs['id']).toBeUndefined();
    }
  });

  it('all nodes pass NodeSchema', async () => {
    for (const sel of ['.site-header', '.hero', '.page']) {
      const snap = await capture(sel);
      const parsed = NodeSchema.safeParse(snap.root);
      expect(parsed.success, sel).toBe(true);
      const ids = all(snap.root).map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(snap.stats.nodes).toBe(ids.length);
    }
  });

  it('a small maxNodes truncates and warns', async () => {
    const snap = await capture('.page', { maxNodes: 5 });
    expect(snap.stats.truncated).toBe(true);
    expect(snap.stats.nodes).toBe(5);
    expect(all(snap.root)).toHaveLength(5);
    expect(snap.stats.warnings.join('\n')).toContain('Limit of 5 nodes');
  });

  it('maxDepth truncates the depth', async () => {
    const snap = await capture('.page', { maxDepth: 1 });
    expect(snap.stats.truncated).toBe(true);
    let deepest = 0;
    walk(snap.root, (_n, d) => (deepest = Math.max(deepest, d)));
    expect(deepest).toBe(1);
  });

  it('inlineAssets: false leaves only the URLs', async () => {
    const snap = await capture('.hero', { inlineAssets: false });
    expect(snap.assets.length).toBeGreaterThan(0);
    expect(snap.assets.every((a) => a.dataUrl === undefined)).toBe(true);
  });

  it('maxInlineTotalBytes counts the size of the data URLs (characters), not the raw bytes', async () => {
    const full = await capture('.hero');
    const sizes = full.assets.filter((a) => a.dataUrl).map((a) => a.dataUrl!.length);
    expect(sizes.length).toBeGreaterThan(0);
    const sum = sizes.reduce((x, y) => x + y, 0);
    // Exactly the real sum: everything fits, no limit warnings.
    const exact = await capture('.hero', { maxInlineTotalBytes: sum });
    expect(exact.assets.filter((a) => a.dataUrl).length).toBe(sizes.length);
    expect(exact.stats.warnings.some((w) => /total byte limit/.test(w))).toBe(false);
    // One character less: the last asset does not fit and becomes a warning, keeping only the URL.
    const tight = await capture('.hero', { maxInlineTotalBytes: sum - 1 });
    expect(tight.assets.filter((a) => a.dataUrl).length).toBe(sizes.length - 1);
    expect(tight.stats.warnings.some((w) => /total byte limit/.test(w))).toBe(true);
  });

  it('the original style attribute of the page elements stays intact', async () => {
    const read = (): Promise<(string | null)[]> =>
      page.evaluate(() => [...document.querySelectorAll('*')].map((e) => e.getAttribute('style')));
    const before = await read();
    await capture('.page');
    const after = await read();
    expect(after).toEqual(before);
    expect(after).toContain('letter-spacing: 0.2px');
    // The defaults iframe was removed.
    expect(await page.evaluate(() => document.querySelectorAll('iframe').length)).toBe(0);
  });

  it('clear error for a selector with no match', async () => {
    await expect(capture('.does-not-exist')).rejects.toThrow(/No element matches/);
  });
});

describe('fonts', () => {
  beforeAll(() => open('/fonts/index.html'));

  it('collects only the @font-face rules of the used families, with the file embedded', async () => {
    const snap = await capture('.fonts-demo');
    expect(snap.fonts).toHaveLength(1);
    const font = snap.fonts[0]!;
    expect(font.family).toBe('Lucide Test');
    expect(font.weight).toBe('400');
    expect(font.style).toBe('normal');
    const asset = snap.assets.find((a) => a.id === font.assetIds[0])!;
    expect(asset.kind).toBe('font');
    expect(asset.url).toBe(`${base}/vendor/lucide.woff2`);
    expect(asset.dataUrl).toMatch(/^data:font\/woff2;base64,/);
    const icon = find(snap.root, (n) => n.name === 'Icon')!;
    expect(icon.style['font-family']).toContain('Lucide Test');
    expect(icon.text).toBe('');
  });
});

describe('extras (position, pseudo-elements, text)', () => {
  beforeAll(() => open('/extras/'));

  it('positioning, transform and root', async () => {
    const snap = await capture('#extras');
    const root = snap.root;
    expect(root.style['position']).toBe('relative');
    expect(root.style['margin-left']).toBeUndefined();
    expect(root.style['margin']).toBeUndefined();
    expect(root.style['color']).toBe('rgb(229, 231, 235)');
    expect(root.style['background-color']).toBe('rgb(31, 41, 55)');

    const sticky = find(root, (n) => n.name === 'Sticky')!;
    expect(sticky.style['position']).toBe('relative');
    expect(sticky.style['top']).toBeUndefined();

    const abs = find(root, (n) => n.name === 'Abs')!;
    expect(abs.style['position']).toBe('absolute');
    expect(abs.style['top']).toBe('10px');
    expect(abs.style['right']).toBe('12px');
    expect(abs.style['width']).toBe('80px');

    const fixed = find(root, (n) => n.name === 'Fixed')!;
    expect(fixed.style['position']).toBe('absolute');
    expect(fixed.style['left']).toMatch(/px$/);
    expect(fixed.style['top']).toMatch(/px$/);
    expect(fixed.style['right']).toBeUndefined();

    const rot = find(root, (n) => n.name === 'Rot')!;
    expect(rot.style['transform']).toMatch(/^matrix\(/);
    expect(rot.style['width']).toBe('120px');
  });

  it('pseudo-elements with quotes, escapes and attr()', async () => {
    const snap = await capture('#extras');
    const tag = find(snap.root, (n) => n.name === 'Tag')!;
    expect(tag.children.map((c) => c.text)).toEqual(['“', 'Quote', ' (7)']);
    expect(tag.children[0]!.style['color']).toBe('rgb(251, 191, 36)');
  });

  it('text: no author style, space between inline elements, preserve and gradient', async () => {
    const snap = await capture('#extras');
    const plain = find(snap.root, (n) => n.name === 'Plain')!;
    expect(plain.style['display']).toBeUndefined();
    expect(plain.children.map(textOf)).toEqual(['no', ' ', 'style', ' authored']);
    expect(find(plain, (n) => n.tag === 'b')?.style).toEqual({}); // bold already comes from the UA
    const pre = find(snap.root, (n) => n.name === 'Pre')!;
    expect(pre.text).toBe('  line 1\n  line 2');
    const grad = find(snap.root, (n) => n.name === 'Gradient-text')!;
    expect(grad.style['-webkit-text-fill-color']).toBe('rgba(0, 0, 0, 0)');
    expect(grad.style['background-clip']).toBe('text');
    expect(NodeSchema.safeParse(snap.root).success).toBe(true);
  });

  it('inline svg: resolved use, CSS paint and inputs', async () => {
    const snap = await capture('#extras');
    const svg = find(snap.root, (n) => n.type === 'svg')!;
    expect(svg.tag).toBe('svg');
    expect(svg.svg).toContain('<symbol');
    expect(svg.svg).toContain('fill="rgb(245, 158, 11)"');
    expect(svg.svg).toContain('width="24"');
    expect(svg.style['width']).toBe('24px');
    // The hidden sprite (0x0) does not become a node.
    expect(all(snap.root).filter((n) => n.type === 'svg')).toHaveLength(1);
    const input = find(snap.root, (n) => n.tag === 'input')!;
    expect(input.attrs['value']).toBe('Hello');
    expect(input.attrs['placeholder']).toBe('Name');
    expect(input.style['width']).toBe('208px'); // content-box 200 + padding and border
    expect(input.children).toEqual([]);
    expect(NodeSchema.safeParse(snap.root).success).toBe(true);
  });
});

describe('whole-page capture (body/html root)', () => {
  beforeAll(() => open('/landing/'));

  // The defaults iframe (`Defaults.init()`) exists during the traversal: it must not become an "Iframe" node.
  it('capturing body does not include the defaults measuring iframe', async () => {
    for (const selector of ['body', 'html']) {
      const snap = await capture(selector);
      expect(
        find(snap.root, (n) => n.name === 'Iframe'),
        `iframe in ${selector}`,
      ).toBeUndefined();
    }
  });

  it('body and html produce a valid tree and leave the page without an iframe', async () => {
    for (const selector of ['body', 'html']) {
      const snap = await capture(selector);
      expect(NodeSchema.safeParse(snap.root).success, selector).toBe(true);
      expect(
        find(snap.root, (n) => n.name === 'Site-header'),
        selector,
      ).toBeTruthy();
    }
    expect(await page.evaluate(() => document.querySelectorAll('iframe').length)).toBe(0);
  });
});
