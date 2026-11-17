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
const extensionDist = path.resolve(
  process.env.MOCKUP_EXTENSION_DIST ?? path.resolve(here, '../../extension/dist'),
);
const fixturesDir = path.resolve(
  process.env.MOCKUP_FIXTURES_DIR ?? path.resolve(here, '../../snapshot-core/test/fixtures'),
);
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
    // `chrome` só existe no service worker; o tipo é declarado aqui para o tsc do editor.
    type Tab = { id?: number; url?: string };
    const api = (
      globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<Tab[]> } } }
    ).chrome;
    const tabs = await api.tabs.query({});
    return tabs.find((t) => t.url === url)?.id;
  }, fixtureUrl);
  expect(tabId, 'aba da fixture encontrada pelo service worker').toBeDefined();
  await sw.evaluate(
    async ([id, opts]) => {
      const start = (
        globalThis as unknown as {
          __mockupStartPicker: (tabId: number, opts: unknown) => Promise<void>;
        }
      ).__mockupStartPicker;
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

/**
 * Diferença entre duas imagens PNG dentro de uma página: razão de pixels com algum canal diferindo
 * mais que `THRESHOLD`. Com `b` ausente, compara `a` com uma imagem lisa da cor do canto de `a`
 * (controle: mede quanto conteúdo a imagem tem, para provar que a comparação enxerga diferenças).
 */
const THRESHOLD = 16;
async function pixelDiffRatio(page: Page, a: Buffer, b: Buffer | null) {
  return page.evaluate(
    async ([aB64, bB64, threshold]) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        return img;
      };
      const ia = await load(aB64!);
      const ib = bB64 ? await load(bB64) : null;
      if (!ib) {
        const c = document.createElement('canvas');
        c.width = ia.naturalWidth;
        c.height = ia.naturalHeight;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(ia, 0, 0);
        const [r, g, bl] = ctx.getImageData(0, 0, 1, 1).data;
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.fillRect(0, 0, c.width, c.height);
        return compare(ia, await loadUrl(c.toDataURL('image/png')));
      }
      return compare(ia, ib);

      async function loadUrl(url: string) {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      }
      function compare(ia: HTMLImageElement, ib: HTMLImageElement) {
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
            Math.abs(da[i]! - db[i]!) > threshold ||
            Math.abs(da[i + 1]! - db[i + 1]!) > threshold ||
            Math.abs(da[i + 2]! - db[i + 2]!) > threshold
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
      }
    },
    [a.toString('base64'), b ? b.toString('base64') : null, THRESHOLD] as const,
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
  const h1 = all.find((n) => n.tag === 'h1');
  expect(h1, 'h1 importado').toBeDefined();
  // O h1 da fixture tem conteúdo misto (`<em>`): o texto é a soma dos textos da subárvore.
  const h1Texts: string[] = [];
  walk(h1!, (n) => {
    if (n.text) h1Texts.push(n.text);
  });
  const fixtureH1 = (await page.locator('.hero h1').first().innerText()).trim();
  expect(h1Texts.join('').replace(/\s+/g, ' ').trim()).toBe(fixtureH1);
  expect(all.some((n) => n.type === 'image' && n.tag === 'img')).toBe(true);
  // Frame oculto de referência.
  let hiddenRef = false;
  frames.forEach((f) => walk(f, (n) => (hiddenRef ||= n.hidden === true)));
  expect(hiddenRef, 'imagem de referência oculta').toBe(true);

  // Editor: mesmo contexto do navegador? Usa uma página com viewport grande.
  const editor = await context.newPage();
  await editor.setViewportSize({ width: 2400, height: 1400 });
  await editor.goto(test.info().project.use.baseURL!);
  const frameEl = editor.getByTestId('canvas-world').locator(`[data-node-id="${root.id}"]`).first();
  await expect(frameEl).toBeVisible();

  // Editável: o texto do h1 aparece como camada.
  await expect(editor.getByTestId(`layer-row-${h1!.id}`)).toBeAttached();

  // Fidelidade: zoom 100% e screenshot do frame no canvas.
  await editor.getByTestId('canvas').focus();
  await editor.keyboard.press('Shift+0');
  await editor.waitForTimeout(500);
  const frameShot = await frameEl.screenshot();
  const diff = await pixelDiffRatio(editor, heroShot, frameShot);
  console.log(
    `[snapshot-extension] razão de pixels diferentes: ${diff.ratio.toFixed(4)}`,
    JSON.stringify(diff),
  );
  expect(diff.ratio).toBeLessThan(0.05);
  // Controle: o frame contra uma imagem lisa da cor de fundo precisa diferir bem mais que a tolerância.
  const control = await pixelDiffRatio(editor, frameShot, null);
  console.log(`[snapshot-extension] controle (frame x fundo liso): ${control.ratio.toFixed(4)}`);
  expect(control.ratio, 'a comparação enxerga o conteúdo').toBeGreaterThan(0.15);

  // Editável de verdade: duplo clique no parágrafo (descendo a hierarquia) entra na edição inline.
  const para = all.find((n) => n.tag === 'p' && n.text)!;
  expect(para, 'parágrafo importado como texto').toBeDefined();
  const paraEl = editor.locator(`[data-node-id="${para.id}"]`).first();
  const textEditor = editor.getByTestId('text-editor');
  for (let i = 0; i < 4 && !(await textEditor.isVisible()); i++) {
    await paraEl.dblclick();
    await editor.waitForTimeout(150);
  }
  await expect(textEditor).toBeVisible();
  await editor.keyboard.press('Control+a');
  await editor.keyboard.type('Texto editado no canvas');
  await editor.keyboard.press('Enter');
  await expect
    .poll(async () => {
      const d = await getDoc(info.docId);
      let found: string | undefined;
      d.pages[0]!.frames.forEach((f) =>
        walk(f, (n) => {
          if (n.id === para.id) found = n.text;
        }),
      );
      return found;
    })
    .toBe('Texto editado no canvas');
  // Fecha as páginas: o clipboard do próximo teste depende do foco da aba da fixture.
  await editor.close();
  await page.close();
});

test('modo copiar: o clipboard recebe o snapshot da .site-header e o editor cola', async () => {
  const info = await createDoc('extensao-copia');
  const page = await startPicker('copy');
  await hoverAndClick(page, '.site-header');
  await page.bringToFront();

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
