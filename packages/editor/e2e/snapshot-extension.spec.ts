/**
 * E2E da extensão de navegador "Capturar seção" (packages/extension), em dois blocos.
 *
 * 1) "extensão com activeTab simulado": o `activeTab` só é concedido quando o usuário aciona a
 *    extensão (clique no ícone ou atalho). Este bloco usa uma CÓPIA de `packages/extension/dist`
 *    numa pasta temporária cujo manifest recebe `host_permissions: ["<all_urls>"]` (só na cópia) e
 *    chama o início do seletor direto no service worker (`globalThis.__mockupStartPicker`). O resto
 *    (injeção do content script, hover, clique, captura, screenshot de referência, POST ao daemon)
 *    é o caminho real. Testes:
 *    - enviar: captura a .hero, o frame chega ao daemon, fica editável e fiel (dimensões e pixels
 *      conferidos com tolerância e controle) no canvas, com a referência oculta e texto editável;
 *    - copiar: o clipboard recebe o snapshot da .site-header e o editor cola (Ctrl+V);
 *    - seção maior que a viewport: a referência sai recortada e o payload leva o aviso;
 *    - app fora do ar: a captura é copiada para o clipboard; erro HTTP do daemon (413): nada é
 *      copiado (o toast de erro mostra o status; o shadow root é fechado e não dá para lê-lo).
 *
 * 2) "manifesto real": carrega `dist/` SEM alteração (sem host_permissions, com `key`, id fixo) e
 *    cobre o caminho real do usuário: o id fixo, o popup (status "no ar" pelo ping), o POST do
 *    service worker (Origin do id fixo + CORS sem host_permissions), a recusa da injeção sem o
 *    gesto do usuário e o fluxo completo pelo popup. Para simular o clique no ícone usa o CDP
 *    `Extensions.triggerAction` (Chromium 159 do Playwright; a conexão é um WebSocket direto ao
 *    `--remote-debugging-port`, porque o Playwright não expõe sessão de browser num contexto
 *    persistente): ele abre o popup de verdade e concede o `activeTab` à aba, como o clique.
 *    O popup não aparece em `context.pages()`; ele é dirigido por `Runtime.evaluate` via CDP.
 *    O que ainda não é coberto: o clique físico no ícone da barra (UI do navegador).
 *
 * Pré-requisito: `npm run build -w @mockup/extension`; sem `dist/manifest.json` o spec é pulado.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { Node } from '@mockup/core';
import { MOCKUP_EXTENSION_ID } from '@mockup/snapshot-core';
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

/** Contexto do bloco em execução (cada bloco abre o seu e fecha no afterAll). */
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
});

test.afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Porta TCP livre (ninguém ouvindo nela depois de devolvida). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** Abre o Chromium do Playwright com a extensão descompactada em `extDir`. */
async function launch(
  profile: string,
  extDir: string,
  extraArgs: string[] = [],
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(path.join(tmpDir, profile), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...extraArgs],
  });
}

async function serviceWorker(): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

/** Abre a fixture e inicia o seletor da extensão na aba (como o popup faria). */
async function startPicker(mode: 'send' | 'copy', port = daemonPort): Promise<Page> {
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
    [tabId!, { mode, port }] as const,
  );
  return page;
}

async function hoverAndClick(page: Page, selector: string): Promise<void> {
  const box = (await page.locator(selector).first().boundingBox())!;
  const viewportH = page.viewportSize()!.height;
  const x = box.x + box.width / 2;
  const y = Math.min(box.y + Math.min(box.height / 2, 400), viewportH - 5);
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

test.describe('extensão com activeTab simulado (cópia com host_permissions)', () => {
  test.beforeAll(async () => {
    // A cópia mantém a `key` do manifest: o id continua o fixo.
    const extDir = path.join(tmpDir, 'extension');
    fs.cpSync(extensionDist, extDir, { recursive: true });
    const manifestFile = path.join(extDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.host_permissions = ['<all_urls>'];
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    context = await launch('profile', extDir);
  });

  test.afterAll(async () => {
    await context?.close().catch(() => {});
  });

  test('o id da extensão é o fixo (key do manifest)', async () => {
    const sw = await serviceWorker();
    expect(sw.url().startsWith(`chrome-extension://${MOCKUP_EXTENSION_ID}/`)).toBe(true);
  });

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
    const frameEl = editor
      .getByTestId('canvas-world')
      .locator(`[data-node-id="${root.id}"]`)
      .first();
    await expect(frameEl).toBeVisible();

    // Editável: o texto do h1 aparece como camada.
    await expect(editor.getByTestId(`layer-row-${h1!.id}`)).toBeAttached();

    // Fidelidade: zoom 100% e screenshot do frame no canvas.
    await editor.getByTestId('canvas').focus();
    await editor.keyboard.press('Shift+0');
    await editor.waitForTimeout(500);
    const frameShot = await frameEl.screenshot();
    const diff = await pixelDiffRatio(editor, heroShot, frameShot);
    // Dimensões das duas imagens batem (±2 px); sem isso a razão compararia só o canto em comum.
    expect(
      Math.abs(diff.a[0]! - diff.b[0]!),
      `largura: original ${diff.a[0]} x canvas ${diff.b[0]}`,
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(diff.a[1]! - diff.b[1]!),
      `altura: original ${diff.a[1]} x canvas ${diff.b[1]}`,
    ).toBeLessThanOrEqual(2);
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
    // Fecha as abas: `startPicker` acha a aba da fixture pela URL e uma sobra pegaria a errada.
    await editor.close();
    await page.close();
  });

  test('seção maior que a viewport: a referência sai recortada e o payload leva o aviso', async () => {
    await createDoc('extensao-recorte');
    const posts: { payload: SnapshotLike }[] = [];
    await context.route('**/api/snapshot', async (route) => {
      posts.push(route.request().postDataJSON() as { payload: SnapshotLike });
      await route.continue();
    });
    try {
      const page = await startPicker('send');
      await page.setViewportSize({ width: 1440, height: 320 });
      await hoverAndClick(page, '.hero');
      await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(1);
      const { payload } = posts[0]!;
      expect(payload.height, 'a .hero é maior que a viewport de 320 px').toBeGreaterThan(320);
      expect(payload.reference, 'referência presente').toBeDefined();
      expect(payload.reference!.height).toBeLessThanOrEqual(320);
      expect(
        payload.stats.warnings.some((w) => /parte visível da seção/.test(w)),
        JSON.stringify(payload.stats.warnings),
      ).toBe(true);
      await page.close();
    } finally {
      await context.unroute('**/api/snapshot');
    }
  });

  test('app fora do ar: a captura é copiada para o clipboard', async () => {
    const page = await startPicker('send', await freePort());
    await hoverAndClick(page, '.site-header');
    await page.bringToFront();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText().catch(() => '')), {
        timeout: 30_000,
      })
      .toMatch(/^\{"format":"mockup-snapshot"/);
    await page.close();
  });

  test('erro HTTP do daemon: nada é copiado (o app respondeu, só recusou)', async () => {
    let hits = 0;
    await context.route('**/api/snapshot', async (route) => {
      hits++;
      await route.fulfill({
        status: 413,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'payload grande demais' }),
      });
    });
    try {
      const page = await startPicker('send');
      await page.bringToFront();
      await page.evaluate(() => navigator.clipboard.writeText('marcador'));
      await hoverAndClick(page, '.site-header');
      await expect.poll(() => hits, { timeout: 30_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(1500);
      await page.bringToFront();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('marcador');
      await page.close();
    } finally {
      await context.unroute('**/api/snapshot');
    }
  });
});

/** Parte do payload do snapshot usada pelas conferências deste spec. */
interface SnapshotLike {
  height: number;
  reference?: { width: number; height: number };
  stats: { warnings: string[] };
}

/** Conexão CDP direta ao browser (o Playwright não expõe sessão de browser em contexto persistente). */
interface Cdp {
  send<T = Record<string, unknown>>(
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<T>;
  close(): void;
}

async function connectCdp(port: number): Promise<Cdp> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Falha ao abrir o WebSocket do CDP.'));
  });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      result?: never;
      error?: { message: string; data?: string };
    };
    const p = msg.id === undefined ? undefined : pending.get(msg.id);
    if (!p || msg.id === undefined) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`.trim()));
    else p.resolve(msg.result as never);
  };
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve: resolve as (v: never) => void, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    close: () => ws.close(),
  };
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

test.describe('manifesto real (dist sem alteração: sem host_permissions, com key)', () => {
  let cdp: Cdp;

  test.beforeAll(async () => {
    const debugPort = await freePort();
    context = await launch('profile-real', extensionDist, [`--remote-debugging-port=${debugPort}`]);
    cdp = await connectCdp(debugPort);
  });

  test.afterAll(async () => {
    cdp?.close();
    await context?.close().catch(() => {});
  });

  const popupUrl = `chrome-extension://${MOCKUP_EXTENSION_ID}/popup.html`;

  async function targets(type?: string): Promise<TargetInfo[]> {
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>(
      'Target.getTargets',
      type === 'tab' ? { filter: [{ type: 'tab' }] } : {},
    );
    return targetInfos;
  }

  /** Id da aba ativa da janela (o service worker só vê o `id`, sem `url`, sem permissão). */
  async function activeTabId(): Promise<number> {
    const sw = await serviceWorker();
    const id = await sw.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          chrome: { tabs: { query(q: object): Promise<{ id?: number }[]> } };
        }
      ).chrome;
      return (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    });
    expect(id, 'aba ativa').toBeDefined();
    return id!;
  }

  test('o manifest carregado não tem host_permissions, tem a key, e o id é o fixo', async () => {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(extensionDist, 'manifest.json'), 'utf8'),
    ) as { host_permissions?: unknown; key?: string };
    expect(onDisk.host_permissions).toBeUndefined();
    expect(onDisk.key).toBeTruthy();

    const sw = await serviceWorker();
    expect(sw.url().startsWith(`chrome-extension://${MOCKUP_EXTENSION_ID}/`), sw.url()).toBe(true);
    const loaded = await sw.evaluate(() =>
      (
        globalThis as unknown as {
          chrome: { runtime: { getManifest(): Record<string, unknown> } };
        }
      ).chrome.runtime.getManifest(),
    );
    expect(loaded['host_permissions']).toBeUndefined();
    expect(loaded['key']).toBeTruthy();
    expect(loaded['permissions']).toEqual(
      expect.arrayContaining(['activeTab', 'scripting', 'clipboardWrite']),
    );
  });

  test('popup: o ping mostra o app no ar; o POST do service worker passa na Origin e no CORS', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    const port = popup.locator('#port');
    const status = popup.locator('#status');

    await port.fill(String(daemonPort));
    await port.dispatchEvent('change');
    await expect(status).toHaveText('Mockup Studio no ar');

    await port.fill(String(await freePort()));
    await port.dispatchEvent('change');
    await expect(status).toContainText('não encontrado');

    // POST real do contexto da extensão (sem host_permissions): se a Origin do id fixo ou o CORS
    // fossem recusados, o fetch rejeitaria; o 400 legível mostra que o daemon aceitou a origem e
    // só rejeitou o corpo vazio.
    const sw = await serviceWorker();
    const result = await sw.evaluate(async (url) => {
      const res = await fetch(`${url}/api/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: {} }),
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    }, DAEMON);
    expect(result.status).toBe(400);
    expect(typeof result.body.error).toBe('string');
    await popup.close();
  });

  test('sem o gesto do usuário a injeção é recusada (e o popup avisa)', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    await page.bringToFront();
    const tabId = await activeTabId();

    const res = await popup.evaluate(
      async ([id, port]) =>
        (
          globalThis as unknown as {
            chrome: {
              runtime: { sendMessage(m: object): Promise<{ ok: boolean; error?: string }> };
            };
          }
        ).chrome.runtime.sendMessage({ type: 'popup-start', tabId: id, mode: 'send', port }),
      [tabId, daemonPort] as const,
    );
    expect(res.ok).toBe(false);
    expect(res.error, 'erro de permissão do Chrome').toMatch(/cannot access|permission|activeTab/i);

    // O popup (aqui numa aba, com a fixture ativa na janela) mostra a mensagem.
    await popup.evaluate(() => document.getElementById('start')!.click());
    await expect(popup.locator('#status')).toHaveText('Não foi possível iniciar nesta página.');
    await popup.close();
    await page.close();
  });

  test('fluxo completo: ícone (CDP) abre o popup, concede activeTab, seleciona e envia ao daemon', async () => {
    const info = await createDoc('extensao-real');
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    await page.bringToFront();

    // Equivale ao clique no ícone: abre o popup de verdade e concede o activeTab à aba.
    const tab = (await targets('tab')).find((t) => t.url === fixtureUrl);
    expect(tab, 'aba da fixture como alvo do CDP').toBeDefined();
    await cdp.send('Extensions.triggerAction', {
      id: MOCKUP_EXTENSION_ID,
      targetId: tab!.targetId,
    });
    let popupTarget: TargetInfo | undefined;
    await expect
      .poll(async () => {
        popupTarget = (await targets()).find((t) => t.type === 'page' && t.url === popupUrl);
        return popupTarget?.targetId;
      })
      .toBeTruthy();
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: popupTarget!.targetId,
      flatten: true,
    });
    const run = async (expression: string): Promise<unknown> => {
      const out = await cdp.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      return out.result.value;
    };

    // Aponta o popup para o daemon de teste e espera o ping.
    await run(
      `(() => { const i = document.getElementById('port'); i.value = '${daemonPort}';` +
        ` i.dispatchEvent(new Event('change')); })()`,
    );
    await expect
      .poll(() => run(`document.getElementById('status').textContent`))
      .toBe('Mockup Studio no ar');
    await run(`document.querySelector('input[name="mode"][value="send"]').click()`);
    await run(`document.getElementById('start').click()`);
    // O popup fecha sozinho depois de iniciar.
    await expect
      .poll(async () => (await targets()).some((t) => t.type === 'page' && t.url === popupUrl))
      .toBe(false);

    await hoverAndClick(page, '.hero');
    await expect
      .poll(async () => (await getDoc(info.docId)).pages[0]!.frames.length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const frames = (await getDoc(info.docId)).pages[0]!.frames;
    expect(frames.some((f) => !f.hidden && f.children.length > 0)).toBe(true);
    expect(
      frames.some((f) => f.hidden),
      'frame oculto de referência',
    ).toBe(true);
    await page.close();
  });
});
