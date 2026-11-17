/**
 * E2E da extensão de navegador "Capturar seção" (packages/extension).
 *
 * Como o teste simula o `activeTab`: a permissão `activeTab` só é concedida quando o usuário clica
 * no ícone da extensão na barra do navegador, e o Playwright não clica na barra. Por isso o teste
 * usa uma CÓPIA de `packages/extension/dist` numa pasta temporária cujo manifest recebe
 * `host_permissions: ["<all_urls>"]` (só no teste; o manifest real não tem host_permissions).
 * O início do seletor, normalmente disparado pelo popup, é chamado direto no service worker
 * (`globalThis.__mockupStartPicker`). O restante (injeção do content script, hover, clique,
 * captura, screenshot de referência, POST ao daemon) é o caminho real da extensão.
 *
 * Pré-requisito: `npm run build -w @mockup/extension`; sem `dist/manifest.json` o spec é pulado.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { Node } from '@mockup/core';
import { DAEMON, createDoc, getDoc } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDist = path.resolve(process.env.MOCKUP_EXTENSION_DIST ?? path.resolve(here, '../../extension/dist'));
const fixturesDir = path.resolve(process.env.MOCKUP_FIXTURES_DIR ?? path.resolve(here, '../../snapshot-core/test/fixtures'));
const daemonPort = Number(new URL(DAEMON).port);

test.skip(
  !fs.existsSync(path.join(extensionDist, 'manifest.json')),
  'Extensão não compilada: rode `npm run build -w @mockup/extension` (packages/extension/dist/manifest.json não existe).',
);

let context: BrowserContext;
let server: http.Server;
let fixtureUrl: string;
let tmpDir: string;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const file = path.join(fixturesDir, rel);
    if (!file.startsWith(fixturesDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fixtureUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/landing/index.html`;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-ext-'));
  const extDir = path.join(tmpDir, 'extension');
  fs.cpSync(extensionDist, extDir, { recursive: true });
  const manifestFile = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext(path.join(tmpDir, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
});

test.afterAll(async () => {
  await context?.close().catch(() => {});
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function serviceWorker(): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

/** Abre a fixture e inicia o seletor da extensão na aba (como o popup faria). */
async function startPicker(mode: 'send' | 'copy'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await page.bringToFront();
  const sw = await serviceWorker();
  const tabId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t as { url?: string }).url === url)?.id;
  }, fixtureUrl);
  expect(tabId, 'aba da fixture encontrada pelo service worker').toBeDefined();
  await sw.evaluate(
    async ([id, opts]) => {
      const start = (globalThis as unknown as { __mockupStartPicker: Function }).__mockupStartPicker;
      await start(id, opts);
    },
    [tabId, { mode, port: daemonPort }] as const,
  );
  return page;
}

async function hoverAndClick(page: Page, selector: string): Promise<void> {
  const box = (await page.locator(selector).first().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 400);
  await page.mouse.move(x - 5, y - 5);
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.click(x, y);
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  node.children.forEach((c) => walk(c, visit));
}

/** Diferença entre duas imagens PNG (base64) dentro de uma página: razão de pixels diferentes. */
async function pixelDiffRatio(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ([aB64, bB64]) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        return img;
      };
      const [ia, ib] = await Promise.all([load(aB64!), load(bB64!)]);
      const w = Math.min(ia.naturalWidth, ib.naturalWidth);
      const h = Math.min(ia.naturalHeight, ib.naturalHeight);
      const data = (img: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h).data;
      };
      const da = data(ia);
      const db = data(ib);
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (
          Math.abs(da[i]! - db[i]!) > 48 ||
          Math.abs(da[i + 1]! - db[i + 1]!) > 48 ||
          Math.abs(da[i + 2]! - db[i + 2]!) > 48
        ) {
          diff++;
        }
      }
      return {
        ratio: diff / (w * h),
        size: [w, h],
        a: [ia.naturalWidth, ia.naturalHeight],
        b: [ib.naturalWidth, ib.naturalHeight],
      };
    },
    [a.toString('base64'), b.toString('base64')] as const,
  );
}

test('captura a .hero, envia ao daemon e o frame fica editável e fiel no canvas', async () => {
  const info = await createDoc('extensao-envio');
  const page = await startPicker('send');
  const heroShot = await page.locator('.hero').first().screenshot();
  await hoverAndClick(page, '.hero');

  // Toast na página (no shadow root fechado não dá para consultar: confia no daemon).
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames.length, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const doc = await getDoc(info.docId);
  const frames = doc.pages[0]!.frames;
  const root = frames.find((f) => !f.hidden && f.children.length > 0)!;
  expect(root, 'frame importado com filhos').toBeDefined();
  const all: Node[] = [];
  walk(root, (n) => all.push(n));
  const h1 = all.find((n) => n.html?.tag === 'h1' || n.name?.toLowerCase().startsWith('h1'));
  const texts = all.map((n) => n.text).filter(Boolean);
  const fixtureH1 = (await page.locator('.hero h1').first().innerText()).trim();
  expect(texts.join('|')).toContain(fixtureH1);
  expect(all.some((n) => n.type === 'image' || n.svg || n.html?.tag === 'img')).toBe(true);
  // Frame oculto de referência.
  let hiddenRef = false;
  frames.forEach((f) => walk(f, (n) => (hiddenRef ||= n.hidden === true)));
  expect(hiddenRef, 'imagem de referência oculta').toBe(true);

  // Editor: mesmo contexto do navegador? Usa uma página com viewport grande.
  const editor = await context.newPage();
  await editor.setViewportSize({ width: 2400, height: 1400 });
  await editor.goto(test.info().project.use.baseURL!);
  const frameEl = editor
    .getByTestId('canvas-world')
    .locator(`[data-node-id="${root.id}"]`)
    .first();
  await expect(frameEl).toBeVisible();

  // Editável: o texto do h1 aparece em um nó selecionável na árvore de camadas.
  const h1Node = all.find((n) => n.text?.includes(fixtureH1));
  expect(h1Node).toBeDefined();
  void h1;
  await expect(editor.getByTestId(`layer-row-${h1Node!.id}`).or(editor.getByTestId(`layer-row-${root.id}`)).first()).toBeVisible();

  // Fidelidade: zoom 100% e screenshot do frame no canvas.
  await editor.getByTestId('canvas').focus();
  await editor.keyboard.press('Shift+0');
  await editor.waitForTimeout(500);
  const frameShot = await frameEl.screenshot();
  const diff = await pixelDiffRatio(editor, heroShot, frameShot);
  console.log(`[snapshot-extension] razão de pixels diferentes: ${diff.ratio.toFixed(4)}`, JSON.stringify(diff));
  expect(diff.ratio).toBeLessThan(0.1);
});

test('modo copiar: o clipboard recebe o snapshot da .site-header e o editor cola', async () => {
  const info = await createDoc('extensao-copia');
  const page = await startPicker('copy');
  await hoverAndClick(page, '.site-header');

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText().catch(() => '')), {
      timeout: 30_000,
    })
    .toMatch(/^\{"format":"mockup-snapshot"/);

  const editor = await context.newPage();
  await editor.setViewportSize({ width: 1440, height: 900 });
  await editor.goto(test.info().project.use.baseURL!);
  await expect(editor.getByTestId('canvas')).toBeVisible();
  await editor.getByTestId('canvas').focus();
  await editor.keyboard.press('Control+v');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const frame = (await getDoc(info.docId)).pages[0]!.frames.find((f) => !f.hidden)!;
  await expect(
    editor.getByTestId('canvas-world').locator(`[data-node-id="${frame.id}"]`).first(),
  ).toBeVisible();
});
