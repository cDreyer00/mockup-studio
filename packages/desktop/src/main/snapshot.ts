/**
 * SnapshotService: motor de captura de páginas (import_url/import_html). Cada importação abre uma
 * BrowserWindow NOVA e isolada (sessão em memória dedicada, sem preload, só http/https/data/blob/about),
 * carrega a URL/HTML, injeta o bundle do `@mockup/snapshot-core` num mundo isolado e devolve o
 * `SnapshotPayload`, com a captura de referência (PNG/JPEG via CDP). Importações são serializadas.
 */
import dns from 'node:dns';
import { BrowserWindow, nativeImage, session, type Session } from 'electron';
import type { PageSnapshotRequest, PageSnapshotResult } from '@mockup/snapshot-core';
import { SNAPSHOT_SCRIPT } from '@mockup/snapshot-core/inject';
import { isPrivateAddress, originOf, subrequestDecision } from './netguard.js';

export interface SnapshotServiceOptions {
  /** Origem do daemon (ex.: `http://127.0.0.1:4747`); páginas importadas não podem chamá-la. */
  baseUrl: () => string;
}

const log = (...a: unknown[]): void => console.error('[mockup-snapshot]', ...a);

const PARTITION = 'mockup-snapshot';
/** Id fixo do mundo isolado em que o bundle roda (o DOM é compartilhado com a página). */
const WORLD_ID = 1001;
/** Validade do cache de resolução de DNS por host (evita resolver a cada requisição). */
const DNS_TTL_MS = 30_000;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const REF_MAX_HEIGHT = 6000;
const REF_MAX_WIDTH_PX = 2000;
const REF_JPEG_THRESHOLD = 3 * 1024 * 1024;
const SETTLE_MS = 300;
const ASSETS_WAIT_MS = 3000;

/** Insere o CSS extra como `<style>` no fim do `<head>` (ou no início do documento/fragmento). */
export function buildHtml(html: string, css?: string, noScript = false): string {
  const out = insertCss(html, css);
  if (!noScript) return out;
  // CSP por <meta> logo no início (depois do doctype, para não cair em quirks mode): nenhum <script>,
  // handler `on*=` ou `javascript:` da página executa. O bundle da captura não é afetado porque roda
  // num mundo isolado via `executeJavaScriptInIsolatedWorld`, que não obedece à CSP da página.
  // (`webPreferences.javascript: false` não serve: derruba também o mundo isolado e a captura trava.)
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

/** `true` quando a requisição aponta para a origem do daemon (127.0.0.1/localhost/[::1] na porta dele). */
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
  /** Origem da página principal da importação corrente (as importações são serializadas). */
  private mainOrigin: string | null = null;
  private dnsCache = new Map<string, { priv: boolean; until: number }>();

  constructor(private opts: SnapshotServiceOptions) {}

  /** Sessão em memória dedicada, configurada uma única vez. */
  private getSession(): Session {
    if (this.ses) return this.ses;
    const ses = session.fromPartition(PARTITION); // sem prefixo `persist:` = em memória
    ses.webRequest.onBeforeRequest((details, callback) => {
      this.shouldCancel(details.url, details.resourceType)
        .catch(() => true)
        .then((cancel) => {
          if (cancel && process.env.MOCKUP_RENDER_DEBUG) log('requisição bloqueada:', details.url);
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
   * Política de rede da janela de captura. O daemon é bloqueado sempre. A navegação principal vai a
   * qualquer http(s) (o dev server do usuário em localhost é um caso legítimo) e passa a ser a origem
   * confiável (redirecionamentos do servidor incluídos). Subrequisições a rede local/privada só passam
   * se forem da origem confiável; nomes de host são resolvidos aqui e bloqueados se algum endereço for
   * privado.
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
   * Resolve o host via `dns.lookup` (com cache curto). Falha de resolução = bloqueia. Risco residual:
   * o resolvedor do Chromium (DoH, cache próprio, rebinding entre a checagem e a conexão) pode
   * divergir deste lookup.
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
      /* já desanexado */
    }
    win.destroy();
  }

  snapshot(req: PageSnapshotRequest): Promise<PageSnapshotResult> {
    if (this.closed) return Promise.reject(new Error('SnapshotService encerrado'));
    return this.enqueue(() => this.run(req));
  }

  private async run(req: PageSnapshotRequest): Promise<PageSnapshotResult> {
    if (this.closed) throw new Error('SnapshotService encerrado');
    if (req.kind === 'url') {
      let proto = '';
      try {
        proto = new URL(req.url).protocol;
      } catch {
        throw new Error(`URL inválida: ${req.url}`);
      }
      if (proto !== 'http:' && proto !== 'https:')
        throw new Error(`Só URLs http(s) podem ser importadas (recebido ${proto || req.url}).`);
    }
    const what = req.kind === 'url' ? req.url : 'o HTML informado';
    // import_html sem baseUrl: nenhuma origem privada é confiável e o JS da página fica desligado
    // (CSP em buildHtml)
    const base = req.kind === 'html' ? this.htmlBase(req) : undefined;
    this.mainOrigin = req.kind === 'url' ? originOf(req.url) : base ? originOf(base) : null;
    const win = this.createWindow(req.viewport);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.destroyWindow(win);
        reject(
          new Error(`Tempo esgotado (${Math.round(req.timeoutMs / 1000)} s) ao importar ${what}.`),
        );
      }, req.timeoutMs);
    });
    const work = this.doSnapshot(win, req, Date.now() + req.timeoutMs);
    work.catch(() => undefined); // se o prazo vencer primeiro, o erro tardio é descartado
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
    // só a navegação inicial é permitida (a do `loadURL` não dispara will-navigate; redirecionamentos
    // do servidor passam por will-redirect). Qualquer navegação posterior da página é bloqueada.
    wc.on('will-navigate', (ev) => ev.preventDefault());
    // mesmo truque do RenderService: janela "mostrada" fora da tela (oculta quebra o screenshot no Windows)
    win.setIgnoreMouseEvents(true);
    win.showInactive();
    return win;
  }

  private async cdp(win: BrowserWindow, method: string, params?: object): Promise<any> {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg.sendCommand(method, params);
  }

  private async load(win: BrowserWindow, req: PageSnapshotRequest): Promise<void> {
    const wc = win.webContents;
    let failure = '';
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) failure = `${desc} (${code})`;
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
      const target = req.kind === 'url' ? req.url : 'o HTML informado';
      throw new Error(`Não foi possível carregar ${target}: ${reason}`);
    }
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
    // o alvo CDP só responde depois da primeira navegação: about:blank antes do override da viewport
    await win.webContents.loadURL('about:blank');
    await this.cdp(win, 'Emulation.setDeviceMetricsOverride', {
      width: req.viewport.width,
      height: req.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.load(win, req);

    // espera o seletor (até o prazo), as fontes e as imagens (limite ~3 s) + folga
    const sel = JSON.stringify(selector);
    const found = await this.isolated<boolean>(
      win,
      `(async () => {
        const end = Date.now() + ${Math.max(500, deadline - Date.now() - 1000)};
        let el = null;
        try { el = document.querySelector(${sel}); } catch (e) { throw new Error('Seletor inválido: ' + ${sel}); }
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
      const where = req.kind === 'url' ? req.url : 'no HTML informado';
      throw new Error(
        `Seletor "${selector}" não encontrado ${req.kind === 'url' ? 'em ' : ''}${where}.`,
      );
    }

    // o bundle define globalThis.MockupSnapshot (no mundo isolado); o retorno é clonado como JSON
    const payload = await this.isolated<PageSnapshotResult>(
      win,
      `${SNAPSHOT_SCRIPT}\n;globalThis.MockupSnapshot.captureSelector(${sel}, { inlineAssets: true })`,
    );
    if (!payload || typeof payload !== 'object')
      throw new Error('A captura não devolveu um snapshot.');

    try {
      const ref = await this.captureReference(win, sel);
      if (ref) payload.reference = ref;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('referência falhou:', msg);
      payload.stats = payload.stats ?? { nodes: 0, truncated: false, warnings: [] };
      (payload.stats.warnings ??= []).push(
        `Não foi possível capturar a imagem de referência: ${msg}`,
      );
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
    if (!rect || rect.width < 1 || rect.height < 1) throw new Error('elemento sem tamanho');
    const height = Math.min(rect.height, REF_MAX_HEIGHT);
    const shot = await this.cdp(win, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: rect.x, y: rect.y, width: rect.width, height, scale: 1 },
      captureBeyondViewport: true,
    });
    let img = nativeImage.createFromBuffer(Buffer.from(shot.data as string, 'base64'));
    if (img.isEmpty()) throw new Error('imagem vazia');
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
