/**
 * Processo principal do Mockup Studio desktop: daemon embutido (HTTP + WS + MCP), motor de render,
 * janela do editor, menu nativo e modo `--headless` (sem janela, usado por `mockup mcp`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, app, dialog, ipcMain, session, shell } from 'electron';
import {
  checkHealth,
  getDataDir,
  normalizeDocumentPath,
  readRecent,
  resolvePort,
  startDaemon,
  takeOverDaemon,
  type DaemonHandle,
} from '@mockup/server';
import { parseArgs, userArgs, type AppArgs } from './args.js';
import {
  SESSION_WATCH_MS,
  dataDirOverride,
  existingDaemonAction,
  mergeFiles,
  onAllWindowsClosed,
  shouldQuitAfterSessions,
} from './lifecycle.js';
import { applyMenu, type MenuAction } from './menu.js';
import { RenderService } from './render.js';

const log = (...a: unknown[]): void => console.error('[mockup-desktop]', ...a);
const here = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'Mockup Studio';

let args: AppArgs;
try {
  args = parseArgs(userArgs(process.argv, process.defaultApp));
} catch (e) {
  console.error('[mockup-desktop] erro:', e instanceof Error ? e.message : e);
  process.exit(2);
}

/**
 * `--install-cli` / `--uninstall-cli` (reparo da instalação): roda o bundle do CLI embutido com o
 * próprio Electron como Node, herdando o stdio, e sai com o código dele. Roda antes de qualquer
 * userData, lock de instância única, daemon ou janela. No executável portátil o `install-cli` recusa
 * (o CLI vê `PORTABLE_EXECUTABLE_DIR`): ele roda de uma pasta temporária.
 */
if (args.cliAction) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'cli', 'mockup.mjs')
    : path.resolve(app.getAppPath(), 'out', 'cli', 'mockup.mjs');
  if (!fs.existsSync(script)) {
    console.error(`[mockup-desktop] CLI embutido não encontrado: ${script}`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [script, args.cliAction, ...args.cliArgs], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (r.error) console.error('[mockup-desktop] erro ao rodar o CLI:', r.error.message);
  process.exit(r.status ?? 1);
}

// userData próprio só quando o usuário pediu (--data-dir ou MOCKUP_DATA_DIR definida antes de
// iniciar): o lock de instância única é por userData (testes e instâncias isoladas).
const userDataDir = dataDirOverride(args, process.env);
if (userDataDir) {
  process.env.MOCKUP_DATA_DIR = userDataDir;
  app.setPath('userData', path.join(userDataDir, 'electron'));
}
if (args.headless && process.env.MOCKUP_DISABLE_GPU === '1') app.disableHardwareAcceleration();
// WebGL no render offscreen (efeitos): sem GPU o Chromium cai no SwiftShader (software) em vez de
// ficar sem WebGL. `MOCKUP_RENDER_GL=swiftshader` força o software (VM/CI).
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
if (process.env.MOCKUP_RENDER_GL === 'swiftshader') {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
}
// ffmpeg empacotado (extraResources) para exportar mp4/webm/gif; o server respeita MOCKUP_FFMPEG
if (app.isPackaged) {
  const bundled = path.join(
    process.resourcesPath,
    'ffmpeg',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  );
  if (fs.existsSync(bundled)) process.env.MOCKUP_FFMPEG ??= bundled;
}
app.setAppUserModelId('app.mockupstudio.desktop');

// ---------------------------------------------------------------- recursos

/** Raiz dos recursos extras: `resources/` empacotado, ou o repositório em desenvolvimento. */
function resolveEditorDir(): string {
  if (process.env.MOCKUP_EDITOR_DIR) return process.env.MOCKUP_EDITOR_DIR;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'editor')
    : path.resolve(app.getAppPath(), '..', 'editor', 'dist');
}
function resolveDocsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'docs')
    : path.resolve(app.getAppPath(), '..', '..', 'docs');
}
function resolveIcon(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');
}

// ---------------------------------------------------------------- estado

let daemon: DaemonHandle | null = null;
let baseUrl = '';
let mainWindow: BrowserWindow | null = null;
/** Iniciado como headless: nunca encerra por fechar janelas (só por sinal/`before-quit`). */
const startedHeadless = args.headless;
let quitting = false;

const origin = (): string => new URL(baseUrl).origin;

// ---------------------------------------------------------------- abrir arquivos

function resolveFiles(files: string[], cwd?: string): string[] {
  return files.map((f) => path.resolve(cwd ?? process.cwd(), f));
}

async function openFiles(files: string[]): Promise<void> {
  for (const file of files) {
    try {
      if (daemon) {
        const info = await daemon.store.open(file);
        daemon.store.setActive(info.docId);
      } else {
        // daemon de outra instância: abre por HTTP
        const res = await fetch(`${baseUrl}/api/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: file }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      log(`não foi possível abrir ${file}:`, e instanceof Error ? e.message : e);
    }
  }
}

// ---------------------------------------------------------------- menu

let menuSignature = '';

function sendMenu(action: MenuAction, arg?: string): void {
  const w = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send('desktop:menu', action, arg);
}

function refreshMenu(force = false): void {
  if (!mainWindow) return;
  const recent = readRecent(getDataDir()).filter((p) => fs.existsSync(p));
  const sig = JSON.stringify(recent);
  if (!force && sig === menuSignature) return;
  menuSignature = sig;
  const docFile = (names: string[]): string => {
    for (const n of names) {
      const p = path.join(resolveDocsDir(), n);
      if (fs.existsSync(p)) return p;
    }
    return path.join(resolveDocsDir(), 'MCP.md');
  };
  applyMenu({
    send: sendMenu,
    recent,
    openMcpDocs: () => void shell.openPath(docFile(['MCP.md'])),
    openExportDocs: () => void shell.openPath(docFile(['EXPORTACAO.md', 'EXPORT.md', 'MCP.md'])),
    showAbout: () =>
      void dialog.showMessageBox({
        type: 'info',
        title: `Sobre o ${APP_NAME}`,
        message: APP_NAME,
        detail:
          `Versão ${app.getVersion()}\n` +
          `Servidor MCP local em ${baseUrl}/mcp\n\n` +
          `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
        icon: undefined,
      }),
    quit: () => app.quit(),
  });
}

// ---------------------------------------------------------------- janela

function isTrustedSender(frameUrl: string | undefined): boolean {
  if (!frameUrl || !baseUrl) return false;
  try {
    return new URL(frameUrl).origin === origin();
  } catch {
    return false;
  }
}

function setupIpc(): void {
  ipcMain.handle('desktop:openDialog', async (e) => {
    if (!isTrustedSender(e.senderFrame?.url)) return null;
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts = {
      title: 'Abrir documento',
      properties: ['openFile' as const],
      filters: [
        { name: 'Mockup Studio (*.mockup.json)', extensions: ['json'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle(
    'desktop:saveDialog',
    async (e, o: { title?: string; defaultPath?: string } | undefined) => {
      if (!isTrustedSender(e.senderFrame?.url)) return null;
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const opts = {
        title: typeof o?.title === 'string' ? o.title : 'Salvar documento',
        defaultPath: typeof o?.defaultPath === 'string' ? o.defaultPath : undefined,
        filters: [{ name: 'Mockup Studio (*.mockup.json)', extensions: ['mockup.json'] }],
      };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      return r.canceled || !r.filePath ? null : normalizeDocumentPath(r.filePath);
    },
  );

  ipcMain.on('desktop:docState', (e, s: { title: string; path: string | null; dirty: boolean }) => {
    if (!isTrustedSender(e.senderFrame?.url)) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    const title = String(s.title ?? '').trim();
    win.setTitle(`${s.dirty ? '• ' : ''}${title ? `${title} — ` : ''}${APP_NAME}`);
    try {
      win.setRepresentedFilename(s.path ?? '');
      win.setDocumentEdited(!!s.dirty);
    } catch {
      /* só macOS */
    }
    refreshMenu();
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: resolveIcon(),
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.on('focus', () => refreshMenu());

  const external = (url: string): void => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.on('will-navigate', (ev, url) => {
    let same = false;
    try {
      same = new URL(url).origin === origin();
    } catch {
      /* URL inválida */
    }
    if (!same) {
      ev.preventDefault();
      external(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });

  void win.loadURL(`${baseUrl}/`);
  mainWindow = win;
  refreshMenu(true);
  return win;
}

function showWindow(): void {
  if (!baseUrl) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createMainWindow();
}

// ---------------------------------------------------------------- inicialização

/** Sobe o daemon embutido (com render) na porta; lança se a porta estiver ocupada. */
function startEmbedded(port: number, files: string[]): Promise<DaemonHandle> {
  const render = new RenderService({ baseUrl: () => baseUrl });
  return startDaemon({
    port,
    render,
    editorDir: resolveEditorDir(),
    openFiles: files,
    writeInfo: true,
    mode: 'desktop',
    // headless (ex.: aberto pelo CLI): `mockup stop` encerra o app; com janela, o daemon recusa (409)
    onShutdown: startedHeadless ? () => app.quit() : undefined,
  });
}

async function startServices(): Promise<boolean> {
  const port = args.port ?? resolvePort();
  const argvFiles = resolveFiles(args.files);
  try {
    daemon = await startEmbedded(port, argvFiles);
    baseUrl = daemon.url;
    log(`daemon embutido em ${daemon.url} (render ativo)`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const url = `http://127.0.0.1:${port}`;
    const other = port > 0 ? await checkHealth(url) : null;
    if (other?.ok && other.name === 'mockup-studio') {
      if (existingDaemonAction(other) === 'takeover') {
        // daemon Node sem render (ex.: um headless antigo): pede o encerramento, espera a porta
        // liberar e assume o lugar, reabrindo os documentos que ele tinha
        log(
          `porta ${port} ocupada por um daemon sem render (pid ${other.pid}); assumindo o lugar dele.`,
        );
        const r = await takeOverDaemon(url);
        if (r.ok) {
          if (r.unsaved > 0)
            log(
              `${r.unsaved} documento(s) sem arquivo do daemon anterior não puderam ser reabertos.`,
            );
          try {
            daemon = await startEmbedded(port, mergeFiles(r.paths, argvFiles));
            baseUrl = daemon.url;
            log(
              `daemon embutido em ${daemon.url} (render ativo; ${r.paths.length} documento(s) reaberto(s))`,
            );
            return true;
          } catch (e2) {
            console.error(
              '[mockup-desktop] não foi possível subir o daemon após encerrar o anterior:',
              e2 instanceof Error ? e2.message : e2,
            );
            if (!startedHeadless)
              dialog.showErrorBox(APP_NAME, 'Não foi possível iniciar o daemon.');
            return false;
          }
        }
        log(
          `não foi possível encerrar o daemon sem render (${r.reason ?? 'recusou'}); mantendo-o.`,
        );
      }
      if (startedHeadless) {
        console.error(
          `[mockup-desktop] já existe um daemon do Mockup Studio na porta ${port}; encerrando o headless.`,
        );
        return false;
      }
      baseUrl = url;
      log(
        `porta ${port} ocupada por outro daemon do Mockup Studio: a janela usará esse daemon; ` +
          `o render/screenshot é o dele (${other.render ? 'ativo' : 'indisponível'}).`,
      );
      await openFiles(argvFiles);
      return true;
    }
    console.error('[mockup-desktop] não foi possível iniciar o daemon:', msg);
    if (!startedHeadless)
      dialog.showErrorBox(APP_NAME, `Não foi possível iniciar o daemon.\n\n${msg}`);
    return false;
  }
}

/** Sem janela e com sessões MCP ativas: segue headless e sai quando as sessões zerarem. */
let sessionWatch: NodeJS.Timeout | null = null;
function watchSessions(): void {
  if (sessionWatch) return;
  sessionWatch = setInterval(() => {
    const hasWindow = !!mainWindow && !mainWindow.isDestroyed();
    if (shouldQuitAfterSessions(startedHeadless, hasWindow, daemon?.sessionCount() ?? 0)) {
      log('sessões MCP encerradas; saindo');
      app.quit();
    }
  }, SESSION_WATCH_MS);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    let second: AppArgs;
    try {
      second = parseArgs(userArgs(argv, process.defaultApp));
    } catch {
      second = { headless: false, files: [] as string[], cliArgs: [] as string[] };
    }
    void (async () => {
      await openFiles(resolveFiles(second.files, cwd));
      // um `--headless` repetido (ex.: CLI) não deve abrir janela
      if (!second.headless) showWindow();
    })();
  });

  app.on('window-all-closed', () => {
    const action = onAllWindowsClosed(startedHeadless, daemon?.sessionCount() ?? 0);
    if (action === 'stay') return;
    if (action === 'watch' && daemon) {
      log(
        `janela fechada; ${daemon.sessionCount()} sessão(ões) MCP ativa(s): seguindo em modo headless`,
      );
      Menu.setApplicationMenu(null);
      watchSessions();
      return;
    }
    app.quit();
  });

  app.on('activate', () => showWindow());

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    void (daemon?.close() ?? Promise.resolve())
      .catch((err: unknown) => log('erro ao encerrar o daemon:', err))
      .finally(() => app.exit(0));
  });

  void app.whenReady().then(async () => {
    setupIpc();
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(
        isTrustedSender(wc.getURL()) &&
          (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'),
      );
    });
    const ok = await startServices();
    if (!ok) {
      app.exit(1);
      return;
    }
    if (startedHeadless) {
      Menu.setApplicationMenu(null);
      app.dock?.hide();
      log('modo headless: sem janela');
    } else {
      createMainWindow();
    }
  });
}
