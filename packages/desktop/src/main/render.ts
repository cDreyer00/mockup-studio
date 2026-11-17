/**
 * RenderService: motor de screenshot/layout do daemon. Mantém UMA BrowserWindow oculta carregando
 * `/render.html` (página de render do editor) e captura o nó via CDP (`Page.captureScreenshot`).
 * Operações são serializadas numa fila; a janela é recriada se o processo de render morrer ou travar.
 */
import { BrowserWindow, nativeImage } from 'electron';
import type { CaptureRequest, CaptureResult, RenderProvider, RenderTarget } from '@mockup/server';
import { getFrameOf, type LayoutNode, type PreviewState, type RenderBox } from '@mockup/core';
import {
  CACHE_MAX_BYTES,
  LruCache,
  assertSize,
  assertViewport,
  assetFingerprints,
  cacheKey,
  declaredSize,
  pngSize,
  referencedAssets,
  withTimeout,
} from './render-utils.js';

export interface RenderServiceOptions {
  /** Origem do daemon (ex.: `http://127.0.0.1:4747`); avaliada sob demanda (a porta só é conhecida após o listen). */
  baseUrl: () => string;
  /** Timeout por operação (padrão 30 s). */
  timeoutMs?: number;
  /** Limite do cache LRU em bytes (padrão 256 MB). */
  cacheBytes?: number;
}

const log = (...a: unknown[]): void => console.error('[mockup-render]', ...a);

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export class RenderService implements RenderProvider {
  private win: BrowserWindow | null = null;
  private winReady: Promise<BrowserWindow> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private cache: LruCache<CaptureResult>;
  private timeoutMs: number;
  private closed = false;

  constructor(private opts: RenderServiceOptions) {
    this.cache = new LruCache(opts.cacheBytes ?? CACHE_MAX_BYTES, (r) => r.data.length);
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  /** Executa `fn` na fila serial (uma operação por vez, mesmo se a anterior falhar). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private destroyWindow(): void {
    const w = this.win;
    this.win = null;
    this.winReady = null;
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.debugger.detach();
      } catch {
        /* já desanexado */
      }
      w.destroy();
    }
  }

  private ensureWindow(): Promise<BrowserWindow> {
    if (this.closed) return Promise.reject(new Error('RenderService encerrado'));
    if (this.win && !this.win.isDestroyed() && this.winReady) return this.winReady;
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      focusable: false,
      x: -20000,
      y: -20000,
      hasShadow: false,
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#00000000',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.win = win;
    // a página de render nunca navega nem abre janelas: tudo que não for o próprio render é negado
    win.webContents.on('will-navigate', (ev) => ev.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Em janela realmente oculta o renderer cai no Page.captureScreenshot (Windows): a janela é
    // "mostrada" sem moldura, transparente, fora da tela, sem foco e fora da barra de tarefas.
    win.setIgnoreMouseEvents(true);
    win.showInactive();
    win.webContents.on('render-process-gone', (_e, details) => {
      log('processo de render encerrou:', details.reason);
      if (this.win === win) this.destroyWindow();
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.winReady = null;
      }
    });
    const ready = (async () => {
      await win.loadURL(`${this.opts.baseUrl()}/render.html`);
      const deadline = Date.now() + this.timeoutMs;
      for (;;) {
        const ok = await win.webContents.executeJavaScript('window.__mockupRenderReady === true');
        if (ok) return win;
        if (Date.now() > deadline)
          throw new Error('A página de render não ficou pronta (__mockupRenderReady).');
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    this.winReady = ready;
    ready.catch((e) => {
      log('falha ao preparar a página de render:', e instanceof Error ? e.message : e);
      if (this.win === win) this.destroyWindow();
    });
    return ready;
  }

  private async cdp(win: BrowserWindow, method: string, params?: object): Promise<any> {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    if (process.env.MOCKUP_RENDER_DEBUG) log('cdp', method, JSON.stringify(params ?? {}));
    return dbg.sendCommand(method, params);
  }

  /** Renderiza o nó com viewport ≥ frame; devolve o retângulo do nó. */
  private async prepare(
    win: BrowserWindow,
    t: RenderTarget,
    scale: number,
    transparent: boolean,
    state?: PreviewState,
  ): Promise<RenderBox> {
    const declared = declaredSize(getFrameOf(t.doc, t.nodeId));
    let vw = Math.ceil(declared.width ?? DEFAULT_VIEWPORT.width);
    let vh = Math.ceil(declared.height ?? DEFAULT_VIEWPORT.height);
    const call = `window.__mockupRender.render(${JSON.stringify({
      doc: t.doc,
      docId: t.docId,
      nodeId: t.nodeId,
      transparent,
      state,
    })})`;
    let box!: RenderBox;
    for (let i = 0; i < 3; i++) {
      assertViewport(vw, vh, scale);
      await this.cdp(win, 'Emulation.setDeviceMetricsOverride', {
        width: vw,
        height: vh,
        deviceScaleFactor: scale,
        mobile: false,
      });
      if (transparent) {
        await this.cdp(win, 'Emulation.setDefaultBackgroundColorOverride', {
          color: { r: 0, g: 0, b: 0, a: 0 },
        });
      } else {
        await this.cdp(win, 'Emulation.setDefaultBackgroundColorOverride');
      }
      box = (await win.webContents.executeJavaScript(call)) as RenderBox;
      const nw = Math.ceil(box.frameWidth);
      const nh = Math.ceil(box.frameHeight);
      if (nw <= vw && nh <= vh) return box;
      vw = Math.max(vw, nw);
      vh = Math.max(vh, nh);
    }
    return box;
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    const scale = req.scale ?? 1;
    const format = req.format ?? 'png';
    // JPG não tem alfa: ignora `transparent`
    const transparent = format === 'png' && !!req.transparent;
    // O estado de prévia e o CSS base (preflight) mudam a imagem: entram na chave pelo docId.
    const key = cacheKey({
      doc: req.doc,
      docId: [req.docId, req.doc.cssBase, req.state].filter(Boolean).join('#'),
      nodeId: req.nodeId,
      scale,
      format,
      quality: req.quality,
      maxWidth: req.maxWidth,
      transparent,
      assets: assetFingerprints(req.assetsDir, referencedAssets(req.doc, req.nodeId)),
    });
    const hit = this.cache.get(key);
    if (hit) return hit;

    return this.enqueue(async () => {
      const again = this.cache.get(key);
      if (again) return again;
      const result = await withTimeout(
        this.doCapture(req, scale, format, transparent),
        this.timeoutMs,
        'captura',
        () => this.destroyWindow(),
      );
      this.cache.set(key, result);
      return result;
    });
  }

  private async doCapture(
    req: CaptureRequest,
    scale: number,
    format: 'png' | 'jpg',
    transparent: boolean,
  ): Promise<CaptureResult> {
    const win = await this.ensureWindow();
    const box = await this.prepare(win, req, scale, transparent, req.state);
    assertSize(box.width, box.height, scale);
    let png: Buffer;
    try {
      const shot = await this.cdp(win, 'Page.captureScreenshot', {
        format: 'png',
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
        captureBeyondViewport: false,
      });
      png = Buffer.from(shot.data as string, 'base64');
    } catch (e) {
      // fallback: capturePage (ignora clip fora da viewport, mas cobre falhas do CDP)
      log('CDP falhou, usando capturePage:', e instanceof Error ? e.message : e);
      const img = await win.webContents.capturePage({
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
      png = img.toPNG();
    }
    let { width: pw, height: ph } = pngSize(png);
    let data = png;
    let mime: CaptureResult['mime'] = 'image/png';
    if (req.maxWidth && req.maxWidth > 0 && pw > req.maxWidth) {
      const resized = nativeImage
        .createFromBuffer(png)
        .resize({ width: Math.round(req.maxWidth), quality: 'best' });
      ({ width: pw, height: ph } = resized.getSize());
      data = resized.toPNG();
      if (format === 'png') png = data;
    }
    if (format === 'jpg') {
      data = nativeImage.createFromBuffer(data).toJPEG(req.quality ?? 90);
      mime = 'image/jpeg';
    }
    return {
      data,
      mime,
      width: box.width,
      height: box.height,
      pixelWidth: pw,
      pixelHeight: ph,
    };
  }

  measure(t: RenderTarget): Promise<LayoutNode> {
    return this.enqueue(() =>
      withTimeout(
        (async () => {
          const win = await this.ensureWindow();
          await this.prepare(win, t, 1, false);
          return (await win.webContents.executeJavaScript(
            `window.__mockupRender.measure(${JSON.stringify(t.nodeId)})`,
          )) as LayoutNode;
        })(),
        this.timeoutMs,
        'medição de layout',
        () => this.destroyWindow(),
      ),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
    this.destroyWindow();
  }
}
