/**
 * E2E of the "Capture section" browser extension (packages/extension), in two blocks.
 *
 * 1) "extension with simulated activeTab": `activeTab` is only granted when the user triggers the
 *    extension (icon click or shortcut). This block uses a COPY of `packages/extension/dist`
 *    in a temporary folder whose manifest gets `host_permissions: ["<all_urls>"]` (copy only) and
 *    calls the picker start directly on the service worker (`globalThis.__mockupStartPicker`). The rest
 *    (content script injection, hover, click, capture, reference screenshot, POST to the daemon)
 *    is the real path. Tests:
 *    - send: captures the .hero, the frame reaches the daemon, stays editable and faithful (dimensions and pixels
 *      checked with tolerance and a control) on the canvas, with the reference hidden and editable text;
 *    - copy: the clipboard receives the .site-header snapshot and the editor pastes it (Ctrl+V);
 *    - section larger than the viewport: the reference comes out cropped and the payload carries the warning;
 *    - app down: the capture is copied to the clipboard; daemon HTTP error (413): nothing is
 *      copied (the error toast shows the status; the shadow root is closed and cannot be read).
 *
 * 2) "real manifest": loads `dist/` UNCHANGED (no host_permissions, with `key`, fixed id) and
 *    covers the user's real path: the fixed id, the popup ("running" status via ping), the service
 *    worker POST (fixed id Origin + CORS without host_permissions), the injection refusal without the
 *    user gesture and the full flow through the popup. To simulate the icon click it uses the CDP
 *    `Extensions.triggerAction` (Playwright's Chromium 159; the connection is a WebSocket straight to
 *    `--remote-debugging-port`, because Playwright does not expose a browser session in a persistent
 *    context): it opens the real popup and grants `activeTab` to the tab, like the click.
 *    The popup does not show up in `context.pages()`; it is driven by `Runtime.evaluate` via CDP.
 *    What is still not covered: the physical click on the toolbar icon (browser UI).
 *
 * Prerequisite: `npm run build -w @mockup/extension`; without `dist/manifest.json` the spec is skipped.
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
  'Extension not built: run `npm run build -w @mockup/extension` (packages/extension/dist/manifest.json does not exist).',
);

/** Context of the running block (each block opens its own and closes it in afterAll). */
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

/** Free TCP port (nobody listening on it after it is returned). */
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

/** Opens Playwright's Chromium with the unpacked extension in `extDir`. */
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

/** Opens the fixture and starts the extension picker on the tab (as the popup would). */
async function startPicker(mode: 'send' | 'copy', port = daemonPort): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await page.bringToFront();
  const sw = await serviceWorker();
  const tabId = await sw.evaluate(async (url) => {
    // `chrome` only exists in the service worker; the type is declared here for the editor's tsc.
    type Tab = { id?: number; url?: string };
    const api = (
      globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<Tab[]> } } }
    ).chrome;
    const tabs = await api.tabs.query({});
    return tabs.find((t) => t.url === url)?.id;
  }, fixtureUrl);
  expect(tabId, 'fixture tab found by the service worker').toBeDefined();
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
 * Difference between two PNG images inside a page: ratio of pixels with some channel differing
 * by more than `THRESHOLD`. With `b` absent, compares `a` with a flat image of `a`'s corner color
 * (control: measures how much content the image has, to prove the comparison sees differences).
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

test.describe('extension with simulated activeTab (copy with host_permissions)', () => {
  test.beforeAll(async () => {
    // The copy keeps the manifest `key`: the id stays the fixed one.
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

  test('the extension id is the fixed one (manifest key)', async () => {
    const sw = await serviceWorker();
    expect(sw.url().startsWith(`chrome-extension://${MOCKUP_EXTENSION_ID}/`)).toBe(true);
  });

  test('captures the .hero, sends it to the daemon and the frame is editable and faithful on the canvas', async () => {
    const info = await createDoc('extension-send');
    const page = await startPicker('send');
    const heroShot = await page.locator('.hero').first().screenshot();
    await hoverAndClick(page, '.hero');

    // Toast on the page (it cannot be queried inside the closed shadow root: trust the daemon).
    await expect
      .poll(async () => (await getDoc(info.docId)).pages[0]!.frames.length, { timeout: 30_000 })
      .toBeGreaterThan(0);

    const doc = await getDoc(info.docId);
    const frames = doc.pages[0]!.frames;
    const root = frames.find((f) => !f.hidden && f.children.length > 0)!;
    expect(root, 'imported frame with children').toBeDefined();
    const all: Node[] = [];
    walk(root, (n) => all.push(n));
    const h1 = all.find((n) => n.tag === 'h1');
    expect(h1, 'imported h1').toBeDefined();
    // The fixture h1 has mixed content (`<em>`): the text is the sum of the subtree texts.
    const h1Texts: string[] = [];
    walk(h1!, (n) => {
      if (n.text) h1Texts.push(n.text);
    });
    const fixtureH1 = (await page.locator('.hero h1').first().innerText()).trim();
    expect(h1Texts.join('').replace(/\s+/g, ' ').trim()).toBe(fixtureH1);
    expect(all.some((n) => n.type === 'image' && n.tag === 'img')).toBe(true);
    // Hidden reference frame.
    let hiddenRef = false;
    frames.forEach((f) => walk(f, (n) => (hiddenRef ||= n.hidden === true)));
    expect(hiddenRef, 'hidden reference image').toBe(true);

    // Editor: same browser context? Uses a page with a large viewport.
    const editor = await context.newPage();
    await editor.setViewportSize({ width: 2400, height: 1400 });
    await editor.goto(test.info().project.use.baseURL!);
    const frameEl = editor
      .getByTestId('canvas-world')
      .locator(`[data-node-id="${root.id}"]`)
      .first();
    await expect(frameEl).toBeVisible();

    // Editable: the h1 text shows up as a layer.
    await expect(editor.getByTestId(`layer-row-${h1!.id}`)).toBeAttached();

    // Fidelity: 100% zoom and a screenshot of the frame on the canvas.
    await editor.getByTestId('canvas').focus();
    await editor.keyboard.press('Shift+0');
    await editor.waitForTimeout(500);
    const frameShot = await frameEl.screenshot();
    const diff = await pixelDiffRatio(editor, heroShot, frameShot);
    // The dimensions of both images match (±2 px); without this the ratio would only compare the shared corner.
    expect(
      Math.abs(diff.a[0]! - diff.b[0]!),
      `width: original ${diff.a[0]} x canvas ${diff.b[0]}`,
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(diff.a[1]! - diff.b[1]!),
      `height: original ${diff.a[1]} x canvas ${diff.b[1]}`,
    ).toBeLessThanOrEqual(2);
    console.log(
      `[snapshot-extension] ratio of differing pixels: ${diff.ratio.toFixed(4)}`,
      JSON.stringify(diff),
    );
    expect(diff.ratio).toBeLessThan(0.05);
    // Control: the frame against a flat image of the background color must differ well beyond the tolerance.
    const control = await pixelDiffRatio(editor, frameShot, null);
    console.log(
      `[snapshot-extension] control (frame x flat background): ${control.ratio.toFixed(4)}`,
    );
    expect(control.ratio, 'the comparison sees the content').toBeGreaterThan(0.15);

    // Truly editable: double-clicking the paragraph (going down the hierarchy) enters inline editing.
    const para = all.find((n) => n.tag === 'p' && n.text)!;
    expect(para, 'paragraph imported as text').toBeDefined();
    const paraEl = editor.locator(`[data-node-id="${para.id}"]`).first();
    const textEditor = editor.getByTestId('text-editor');
    for (let i = 0; i < 4 && !(await textEditor.isVisible()); i++) {
      await paraEl.dblclick();
      await editor.waitForTimeout(150);
    }
    await expect(textEditor).toBeVisible();
    await editor.keyboard.press('Control+a');
    await editor.keyboard.type('Text edited on the canvas');
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
      .toBe('Text edited on the canvas');
    // Close the pages: the next test's clipboard depends on the focus of the fixture tab.
    await editor.close();
    await page.close();
  });

  test('copy mode: the clipboard receives the .site-header snapshot and the editor pastes it', async () => {
    const info = await createDoc('extension-copy');
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
    // Close the tabs: `startPicker` finds the fixture tab by URL and a leftover would pick the wrong one.
    await editor.close();
    await page.close();
  });

  test('section larger than the viewport: the reference comes out cropped and the payload carries the warning', async () => {
    await createDoc('extension-crop');
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
      expect(payload.height, 'the .hero is larger than the 320 px viewport').toBeGreaterThan(320);
      expect(payload.reference, 'reference present').toBeDefined();
      expect(payload.reference!.height).toBeLessThanOrEqual(320);
      expect(
        payload.stats.warnings.some((w) => /visible part of the section/.test(w)),
        JSON.stringify(payload.stats.warnings),
      ).toBe(true);
      await page.close();
    } finally {
      await context.unroute('**/api/snapshot');
    }
  });

  test('app down: the capture is copied to the clipboard', async () => {
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

  test('daemon HTTP error: nothing is copied (the app answered, it just refused)', async () => {
    let hits = 0;
    await context.route('**/api/snapshot', async (route) => {
      hits++;
      await route.fulfill({
        status: 413,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'payload too large' }),
      });
    });
    try {
      const page = await startPicker('send');
      await page.bringToFront();
      await page.evaluate(() => navigator.clipboard.writeText('marker'));
      await hoverAndClick(page, '.site-header');
      await expect.poll(() => hits, { timeout: 30_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(1500);
      await page.bringToFront();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('marker');
      await page.close();
    } finally {
      await context.unroute('**/api/snapshot');
    }
  });
});

/** Part of the snapshot payload used by this spec's checks. */
interface SnapshotLike {
  height: number;
  reference?: { width: number; height: number };
  stats: { warnings: string[] };
}

/** Direct CDP connection to the browser (Playwright does not expose a browser session in a persistent context). */
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
    ws.onerror = () => reject(new Error('Failed to open the CDP WebSocket.'));
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

test.describe('real manifest (unchanged dist: no host_permissions, with key)', () => {
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

  /** Id of the window's active tab (the service worker only sees the `id`, no `url`, without permission). */
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
    expect(id, 'active tab').toBeDefined();
    return id!;
  }

  test('the loaded manifest has no host_permissions, has the key, and the id is the fixed one', async () => {
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

  test('popup: the ping shows the app running; the service worker POST passes Origin and CORS', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    const port = popup.locator('#port');
    const status = popup.locator('#status');

    await port.fill(String(daemonPort));
    await port.dispatchEvent('change');
    await expect(status).toHaveText('Mockup Studio is running');

    await port.fill(String(await freePort()));
    await port.dispatchEvent('change');
    await expect(status).toContainText('not found');

    // Real POST from the extension context (no host_permissions): if the fixed id Origin or CORS
    // were refused, the fetch would reject; the readable 400 shows that the daemon accepted the origin and
    // only rejected the empty body.
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

  test('without the user gesture the injection is refused (and the popup warns)', async () => {
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
    expect(res.error, 'Chrome permission error').toMatch(/cannot access|permission|activeTab/i);

    // The popup (here in a tab, with the fixture active in the window) shows the message.
    await popup.evaluate(() => document.getElementById('start')!.click());
    await expect(popup.locator('#status')).toHaveText('Could not start on this page.');
    await popup.close();
    await page.close();
  });

  test('full flow: icon (CDP) opens the popup, grants activeTab, selects and sends to the daemon', async () => {
    const info = await createDoc('extension-real');
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    await page.bringToFront();

    // Equivalent to the icon click: opens the real popup and grants activeTab to the tab.
    const tab = (await targets('tab')).find((t) => t.url === fixtureUrl);
    expect(tab, 'fixture tab as the CDP target').toBeDefined();
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

    // The target shows up before popup.js runs: wait for the initial ping (port saved in localStorage,
    // which a previous test left on a port with nobody listening), otherwise the script overwrites the port.
    await expect
      .poll(() => run(`document.getElementById('status')?.dataset.state ?? ''`))
      .toMatch(/^(up|down)$/);
    // Point the popup at the test daemon and wait for the ping.
    await run(
      `(() => { const i = document.getElementById('port'); i.value = '${daemonPort}';` +
        ` i.dispatchEvent(new Event('change')); })()`,
    );
    await expect
      .poll(() => run(`document.getElementById('status').textContent`))
      .toBe('Mockup Studio is running');
    await run(`document.querySelector('input[name="mode"][value="send"]').click()`);
    await run(`document.getElementById('start').click()`);
    // The popup closes by itself after starting.
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
      'hidden reference frame',
    ).toBe(true);
    await page.close();
  });
});
