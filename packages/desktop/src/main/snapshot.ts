/**
 * SnapshotService: page capture engine (import_url/import_html). Each import opens a NEW,
 * isolated BrowserWindow (dedicated in-memory session, no preload, only http/https/data/blob/about),
 * loads the URL/HTML, injects the `@mockup/snapshot-core` bundle into an isolated world and returns the
 * `SnapshotPayload`, with the reference capture (PNG/JPEG via CDP). Imports are serialized.
 */
import dns from 'node:dns';
import { BrowserWindow, nativeImage, session, type Session } from 'electron';
import type { PageSnapshotRequest, PageSnapshotResult } from '@mockup/snapshot-core';
import { SNAPSHOT_SCRIPT } from '@mockup/snapshot-core/inject';
import { isPrivateAddress, originOf, subrequestDecision } from './netguard.js';

export interface SnapshotServiceOptions {
  /** Daemon origin (e.g. `http://127.0.0.1:4747`); imported pages cannot call it. */
  baseUrl: () => string;
}

const log = (...a: unknown[]): void => console.error('[mockup-snapshot]', ...a);

const PARTITION = 'mockup-snapshot';
/** Fixed id of the isolated world the bundle runs in (the DOM is shared with the page). */
const WORLD_ID = 1001;
/** Validity of the per-host DNS resolution cache (avoids resolving on every request). */
const DNS_TTL_MS = 30_000;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const REF_MAX_HEIGHT = 6000;
const REF_MAX_WIDTH_PX = 2000;
const REF_JPEG_THRESHOLD = 3 * 1024 * 1024;
const SETTLE_MS = 300;
const ASSETS_WAIT_MS = 3000;
/**
 * How long to wait for the selector after load. Pages with JS (import_url, import_html with a base) may
 * build the DOM after load; static HTML (import_html without a base, JS turned off by the CSP) is already
 * entirely in the DOM, so the tolerance is short.
 */
const SELECTOR_WAIT_MS = 5000;
const SELECTOR_WAIT_STATIC_MS = 1000;

/** Inserts the extra CSS as `<style>` at the end of `<head>` (or at the start of the document/fragment). */
export function buildHtml(html: string, css?: string, noScript = false): string {
  const out = insertCss(html, css);
  if (!noScript) return out;
  // CSP via <meta> right at the start (after the doctype, to avoid quirks mode): no <script>,
  // `on*=` handler or `javascript:` from the page runs. The capture bundle is unaffected because it runs
  // in an isolated world via `executeJavaScriptInIsolatedWorld`, which does not obey the page's CSP.
  // (`webPreferences.javascript: false` does not work: it also takes down the isolated world and the capture hangs.)
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`;
  const doctype = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(out);
  const at = doctype ? doctype[0].length : 0;
  return out.slice(0, at) + csp + out.slice(at);
}

function insertCss(html: string, css?: string): string {
  if (!css || !css.trim()) return html;
  const style = `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
  const head = /<\/head\s*>/i.exec(html);
  if (head) return html.slice(0, head.index) + style + html.slice(head.index);
  const open = /<head(\s[^>]*)?>/i.exec(html);
  if (open) {
    const at = open.index + open[0].length;
    return html.slice(0, at) + style + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + style + html.slice(doctype[0].length);
  return style + html;
}

/** `true` when the request points to the daemon's origin (127.0.0.1/localhost/[::1] on its port). */
export function isDaemonRequest(rawUrl: string, daemonBase: string): boolean {
  try {
    const u = new URL(rawUrl);
    const d = new URL(daemonBase);
    if (
      u.protocol !== 'http:' &&
      u.protocol !== 'https:' &&
      u.protocol !== 'ws:' &&
      u.protocol !== 'wss:'
    )
      return false;
    const port = (x: URL): string =>
      x.port || (x.protocol === 'https:' || x.protocol === 'wss:' ? '443' : '80');
    return LOCAL_HOSTS.has(u.hostname.toLowerCase()) && port(u) === port(d);
  } catch {
    return false;
  }
}

export class SnapshotService {
  private queue: Promise<unknown> = Promise.resolve();
  private win: BrowserWindow | null = null;
  private ses: Session | null = null;
  private closed = false;
  /** Origin of the main page of the current import (imports are serialized). */
  private mainOrigin: string | null = null;
  private dnsCache = new Map<string, { priv: boolean; until: number }>();

  constructor(private opts: SnapshotServiceOptions) {}

  /** Dedicated in-memory session, configured only once. */
  private getSession(): Session {
    if (this.ses) return this.ses;
    const ses = session.fromPartition(PARTITION); // no `persist:` prefix = in memory
    ses.webRequest.onBeforeRequest((details, callback) => {
      this.shouldCancel(details.url, details.resourceType)
        .catch(() => true)
        .then((cancel) => {
          if (cancel && process.env.MOCKUP_RENDER_DEBUG) log('request blocked:', details.url);
          callback({ cancel });
        });
    });
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (ev) => ev.preventDefault());
    this.ses = ses;
    return ses;
  }

  /**
   * Network policy of the capture window. The daemon is always blocked. The main navigation goes to
   * any http(s) (the user's dev server on localhost is a legitimate case) and becomes the trusted
   * origin (server redirects included). Subrequests to the local/private network only pass
   * if they are from the trusted origin; hostnames are resolved here and blocked if any address is
   * private.
   */
  private async shouldCancel(rawUrl: string, resourceType: string): Promise<boolean> {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return true;
    }
    if (isDaemonRequest(rawUrl, this.opts.baseUrl())) return true;
    if (resourceType === 'mainFrame') {
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        this.mainOrigin = originOf(rawUrl);
        return false;
      }
      return subrequestDecision(rawUrl, null) !== 'allow';
    }
    const decision = subrequestDecision(rawUrl, this.mainOrigin);
    if (decision !== 'resolve') return decision === 'block';
    return this.resolvesToPrivate(u.hostname);
  }

  /**
   * Resolves the host via `dns.lookup` (with a short cache). Resolution failure = block. Residual risk:
   * Chromium's resolver (DoH, its own cache, rebinding between the check and the connection) may
   * diverge from this lookup.
   */
  private async resolvesToPrivate(host: string): Promise<boolean> {
    const key = host.toLowerCase();
    const hit = this.dnsCache.get(key);
    if (hit && hit.until > Date.now()) return hit.priv;
    let priv: boolean;
    try {
      const addrs = await dns.promises.lookup(key, { all: true });
      priv = addrs.some((a) => isPrivateAddress(a.address));
    } catch {
      priv = true;
    }
    this.dnsCache.set(key, { priv, until: Date.now() + DNS_TTL_MS });
    return priv;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private destroyWindow(win: BrowserWindow | null): void {
    if (!win) return;
    if (this.win === win) this.win = null;
    if (win.isDestroyed()) return;
    try {
      win.webContents.debugger.detach();
    } catch {
      /* already detached */
    }
    win.destroy();
  }

  snapshot(req: PageSnapshotRequest): Promise<PageSnapshotResult> {
    if (this.closed) return Promise.reject(new Error('SnapshotService closed'));
    return this.enqueue(() => this.run(req));
  }

  private async run(req: PageSnapshotRequest): Promise<PageSnapshotResult> {
    if (this.closed) throw new Error('SnapshotService closed');
    if (req.kind === 'url') {
      let proto = '';
      try {
        proto = new URL(req.url).protocol;
      } catch {
        throw new Error(`Invalid URL: ${req.url}`);
      }
      if (proto !== 'http:' && proto !== 'https:')
        throw new Error(`Only http(s) URLs can be imported (received ${proto || req.url}).`);
    }
    const what = req.kind === 'url' ? req.url : 'the provided HTML';
    // import_html without baseUrl: no private origin is trusted and the page's JS is turned off
    // (CSP in buildHtml)
    const base = req.kind === 'html' ? this.htmlBase(req) : undefined;
    this.mainOrigin = req.kind === 'url' ? originOf(req.url) : base ? originOf(base) : null;
    const win = this.createWindow(req.viewport);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.destroyWindow(win);
        reject(
          new Error(`Timed out (${Math.round(req.timeoutMs / 1000)} s) while importing ${what}.`),
        );
      }, req.timeoutMs);
    });
    const work = this.doSnapshot(win, req, Date.now() + req.timeoutMs);
    work.catch(() => undefined); // if the deadline expires first, the late error is discarded
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      this.mainOrigin = null;
      this.destroyWindow(win);
    }
  }

  private htmlBase(req: PageSnapshotRequest): string | undefined {
    return req.kind === 'html' && req.baseUrl && /^https?:\/\//i.test(req.baseUrl)
      ? req.baseUrl
      : undefined;
  }

  private createWindow(viewport: { width: number; height: number }): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      x: -20000,
      y: -20000,
      hasShadow: false,
      useContentSize: true,
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height)),
      paintWhenInitiallyHidden: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        session: this.getSession(),
      },
    });
    this.win = win;
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // only the initial navigation is allowed (the `loadURL` one does not fire will-navigate; server redirects
    // go through will-redirect). Any later navigation of the page is blocked.
    wc.on('will-navigate', (ev) => ev.preventDefault());
    // same trick as RenderService: window "shown" off-screen (hidden breaks the screenshot on Windows)
    win.setIgnoreMouseEvents(true);
    win.showInactive();
    return win;
  }

  private async cdp(win: BrowserWindow, method: string, params?: object): Promise<any> {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg.sendCommand(method, params);
  }

  /** Loads the page; returns the HTTP status of the main navigation (import_url; 0 if none). */
  private async load(win: BrowserWindow, req: PageSnapshotRequest): Promise<number> {
    const wc = win.webContents;
    let failure = '';
    let status = 0;
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) failure = `${desc} (${code})`;
    });
    // `did-navigate` only fires for the main frame (the last one counts: server redirects)
    wc.on('did-navigate', (_e, _url, code) => {
      status = code;
    });
    try {
      if (req.kind === 'url') {
        await wc.loadURL(req.url);
      } else {
        const html = buildHtml(req.html, req.css, !this.htmlBase(req));
        const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
        const base = this.htmlBase(req);
        await wc.loadURL(url, base ? { baseURLForDataURL: base } : undefined);
      }
    } catch (e) {
      const reason = failure || (e instanceof Error ? e.message : String(e));
      const target = req.kind === 'url' ? req.url : 'the provided HTML';
      throw new Error(`Could not load ${target}: ${reason}`);
    }
    return req.kind === 'url' ? status : 0;
  }

  private isolated<T>(win: BrowserWindow, code: string): Promise<T> {
    return win.webContents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]) as Promise<T>;
  }

  private async doSnapshot(
    win: BrowserWindow,
    req: PageSnapshotRequest,
    deadline: number,
  ): Promise<PageSnapshotResult> {
    const selector = req.selector?.trim() || 'body';
    // the CDP target only responds after the first navigation: about:blank before the viewport override
    await win.webContents.loadURL('about:blank');
    await this.cdp(win, 'Emulation.setDeviceMetricsOverride', {
      width: req.viewport.width,
      height: req.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const status = await this.load(win, req);

    // waits for the selector (short: see SELECTOR_WAIT_MS), the fonts and the images (limit ~3 s) + slack
    const sel = JSON.stringify(selector);
    const staticHtml = req.kind === 'html' && !this.htmlBase(req);
    const selectorWait = staticHtml ? SELECTOR_WAIT_STATIC_MS : SELECTOR_WAIT_MS;
    const waitMs = Math.max(0, Math.min(selectorWait, deadline - Date.now() - 1000));
    const found = await this.isolated<boolean>(
      win,
      `(async () => {
        const end = Date.now() + ${waitMs};
        let el = null;
        try { el = document.querySelector(${sel}); } catch (e) { throw new Error('Invalid selector: ' + ${sel}); }
        while (!el && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 50));
          el = document.querySelector(${sel});
        }
        if (!el) return false;
        const cap = (p) => Promise.race([p, new Promise((r) => setTimeout(r, ${ASSETS_WAIT_MS}))]);
        try { await cap(document.fonts.ready); } catch {}
        const imgs = Array.from(document.images).filter((i) => !i.complete);
        await cap(Promise.all(imgs.map((i) => new Promise((r) => {
          i.addEventListener('load', r, { once: true });
          i.addEventListener('error', r, { once: true });
        }))));
        await new Promise((r) => setTimeout(r, ${SETTLE_MS}));
        return true;
      })()`,
    );
    if (!found) {
      const where = req.kind === 'url' ? `at ${req.url}` : 'in the provided HTML';
      const waited = Math.round(waitMs / 100) / 10;
      throw new Error(
        `Selector "${selector}" not found ${where} (waited ${waited} s after loading).`,
      );
    }

    // the bundle defines globalThis.MockupSnapshot (in the isolated world); the return value is cloned as JSON
    const payload = await this.isolated<PageSnapshotResult>(
      win,
      `${SNAPSHOT_SCRIPT}\n;globalThis.MockupSnapshot.captureSelector(${sel}, { inlineAssets: true })`,
    );
    if (!payload || typeof payload !== 'object')
      throw new Error('The capture did not return a snapshot.');
    if (status >= 400) {
      // a warning, not an error: the error page may be exactly what you want to import
      payload.stats = payload.stats ?? { nodes: 0, truncated: false, warnings: [] };
      (payload.stats.warnings ??= []).push(
        `The page responded with HTTP ${status}: the imported content may be the server's error page.`,
      );
    }

    try {
      const ref = await this.captureReference(win, sel);
      if (ref) payload.reference = ref;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('reference failed:', msg);
      payload.stats = payload.stats ?? { nodes: 0, truncated: false, warnings: [] };
      (payload.stats.warnings ??= []).push(`Could not capture the reference image: ${msg}`);
    }
    return payload;
  }

  private async captureReference(
    win: BrowserWindow,
    sel: string,
  ): Promise<PageSnapshotResult['reference'] | undefined> {
    const rect = await this.isolated<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>(
      win,
      `(() => {
        const el = document.querySelector(${sel});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
      })()`,
    );
    if (!rect || rect.width < 1 || rect.height < 1) throw new Error('element has no size');
    const height = Math.min(rect.height, REF_MAX_HEIGHT);
    const shot = await this.cdp(win, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: rect.x, y: rect.y, width: rect.width, height, scale: 1 },
      captureBeyondViewport: true,
    });
    let img = nativeImage.createFromBuffer(Buffer.from(shot.data as string, 'base64'));
    if (img.isEmpty()) throw new Error('empty image');
    if (img.getSize().width > REF_MAX_WIDTH_PX)
      img = img.resize({ width: REF_MAX_WIDTH_PX, quality: 'best' });
    let data = img.toPNG();
    let mime = 'image/png';
    if (data.length > REF_JPEG_THRESHOLD) {
      data = img.toJPEG(85);
      mime = 'image/jpeg';
    }
    return {
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
      width: Math.round(rect.width),
      height: Math.round(height),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.destroyWindow(this.win);
  }
}
