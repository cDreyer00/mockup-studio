/**
 * Mockup Studio desktop main process: embedded daemon (HTTP + WS + MCP), render engine,
 * editor window, native menu and `--headless` mode (no window, used by `mockup mcp`).
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
  console.error('[mockup-desktop] error:', e instanceof Error ? e.message : e);
  process.exit(2);
}

/**
 * `--install-cli` / `--uninstall-cli` (install repair): runs the embedded CLI bundle with
 * Electron itself as Node, inheriting stdio, and exits with its code. Runs before any
 * userData, single-instance lock, daemon or window. In the portable executable `install-cli` refuses
 * (the CLI sees `PORTABLE_EXECUTABLE_DIR`): it runs from a temporary folder.
 */
if (args.cliAction) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'cli', 'mockup.mjs')
    : path.resolve(app.getAppPath(), 'out', 'cli', 'mockup.mjs');
  if (!fs.existsSync(script)) {
    console.error(`[mockup-desktop] embedded CLI not found: ${script}`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [script, args.cliAction, ...args.cliArgs], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (r.error) console.error('[mockup-desktop] error running the CLI:', r.error.message);
  process.exit(r.status ?? 1);
}

// Own userData only when the user asked for it (--data-dir or MOCKUP_DATA_DIR set before
// starting): the single-instance lock is per userData (tests and isolated instances).
const userDataDir = dataDirOverride(args, process.env);
if (userDataDir) {
  process.env.MOCKUP_DATA_DIR = userDataDir;
  app.setPath('userData', path.join(userDataDir, 'electron'));
}
if (args.headless && process.env.MOCKUP_DISABLE_GPU === '1') app.disableHardwareAcceleration();
// WebGL in the effects render without a GPU: SwiftShader (software) is only enabled in headless mode
// (screenshot engine, no third-party iframes or YouTube) or with `MOCKUP_RENDER_GL=swiftshader`,
// which also forces software rendering (VM/CI). The interactive window uses the GPU only.
const forceSwiftShader = process.env.MOCKUP_RENDER_GL === 'swiftshader';
if (args.headless || forceSwiftShader) app.commandLine.appendSwitch('enable-unsafe-swiftshader');
if (forceSwiftShader) {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
}
// Bundled ffmpeg (extraResources) to export mp4/webm/gif; the server honors MOCKUP_FFMPEG
if (app.isPackaged) {
  const bundled = path.join(
    process.resourcesPath,
    'ffmpeg',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  );
  if (fs.existsSync(bundled)) process.env.MOCKUP_FFMPEG ??= bundled;
}
app.setAppUserModelId('app.mockupstudio.desktop');

// ---------------------------------------------------------------- resources

/** Root of the extra resources: the packaged `resources/`, or the repository in development. */
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

// ---------------------------------------------------------------- state

let daemon: DaemonHandle | null = null;
let baseUrl = '';
let mainWindow: BrowserWindow | null = null;
/** Started as headless: never quits when windows close (only by signal/`before-quit`). */
const startedHeadless = args.headless;
let quitting = false;

const origin = (): string => new URL(baseUrl).origin;

// ---------------------------------------------------------------- open files

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
        // daemon of another instance: open via HTTP
        const res = await fetch(`${baseUrl}/api/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: file }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      log(`could not open ${file}:`, e instanceof Error ? e.message : e);
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
    openExportDocs: () => void shell.openPath(docFile(['EXPORT.md', 'MCP.md'])),
    showAbout: () =>
      void dialog.showMessageBox({
        type: 'info',
        title: `About ${APP_NAME}`,
        message: APP_NAME,
        detail:
          `Version ${app.getVersion()}\n` +
          `Local MCP server at ${baseUrl}/mcp\n\n` +
          `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
        icon: undefined,
      }),
    quit: () => app.quit(),
  });
}

// ---------------------------------------------------------------- window

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
      title: 'Open document',
      properties: ['openFile' as const],
      filters: [
        { name: 'Mockup Studio (*.mockup.json)', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
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
        title: typeof o?.title === 'string' ? o.title : 'Save document',
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
      /* macOS only */
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
      /* invalid URL */
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

// ---------------------------------------------------------------- startup

/** Starts the embedded daemon (with render) on the port; throws if the port is in use. */
function startEmbedded(port: number, files: string[]): Promise<DaemonHandle> {
  const render = new RenderService({ baseUrl: () => baseUrl });
  return startDaemon({
    port,
    render,
    editorDir: resolveEditorDir(),
    openFiles: files,
    writeInfo: true,
    mode: 'desktop',
    // headless (e.g. opened by the CLI): `mockup stop` quits the app; with a window, the daemon refuses (409)
    onShutdown: startedHeadless ? () => app.quit() : undefined,
  });
}

async function startServices(): Promise<boolean> {
  const port = args.port ?? resolvePort();
  const argvFiles = resolveFiles(args.files);
  try {
    daemon = await startEmbedded(port, argvFiles);
    baseUrl = daemon.url;
    log(`embedded daemon at ${daemon.url} (render active)`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const url = `http://127.0.0.1:${port}`;
    const other = port > 0 ? await checkHealth(url) : null;
    if (other?.ok && other.name === 'mockup-studio') {
      if (existingDaemonAction(other) === 'takeover') {
        // Node daemon without render (e.g. an old headless one): asks it to shut down, waits for the port
        // to free up and takes its place, reopening the documents it had
        log(
          `port ${port} is in use by a daemon without render (pid ${other.pid}); taking its place.`,
        );
        const r = await takeOverDaemon(url);
        if (r.ok) {
          if (r.unsaved > 0)
            log(`${r.unsaved} unsaved document(s) from the previous daemon could not be reopened.`);
          try {
            daemon = await startEmbedded(port, mergeFiles(r.paths, argvFiles));
            baseUrl = daemon.url;
            log(
              `embedded daemon at ${daemon.url} (render active; ${r.paths.length} document(s) reopened)`,
            );
            return true;
          } catch (e2) {
            console.error(
              '[mockup-desktop] could not start the daemon after shutting down the previous one:',
              e2 instanceof Error ? e2.message : e2,
            );
            if (!startedHeadless) dialog.showErrorBox(APP_NAME, 'Could not start the daemon.');
            return false;
          }
        }
        log(
          `could not shut down the daemon without render (${r.reason ?? 'refused'}); keeping it.`,
        );
      }
      if (startedHeadless) {
        console.error(
          `[mockup-desktop] a Mockup Studio daemon already exists on port ${port}; shutting down the headless instance.`,
        );
        return false;
      }
      baseUrl = url;
      log(
        `port ${port} is in use by another Mockup Studio daemon: the window will use that daemon; ` +
          `render/screenshot is its own (${other.render ? 'active' : 'unavailable'}).`,
      );
      await openFiles(argvFiles);
      return true;
    }
    console.error('[mockup-desktop] could not start the daemon:', msg);
    if (!startedHeadless) dialog.showErrorBox(APP_NAME, `Could not start the daemon.\n\n${msg}`);
    return false;
  }
}

/** No window and with active MCP sessions: keeps running headless and quits when the sessions drop to zero. */
let sessionWatch: NodeJS.Timeout | null = null;
function watchSessions(): void {
  if (sessionWatch) return;
  sessionWatch = setInterval(() => {
    const hasWindow = !!mainWindow && !mainWindow.isDestroyed();
    if (shouldQuitAfterSessions(startedHeadless, hasWindow, daemon?.sessionCount() ?? 0)) {
      log('MCP sessions ended; quitting');
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
      // a repeated `--headless` (e.g. CLI) must not open a window
      if (!second.headless) showWindow();
    })();
  });

  app.on('window-all-closed', () => {
    const action = onAllWindowsClosed(startedHeadless, daemon?.sessionCount() ?? 0);
    if (action === 'stay') return;
    if (action === 'watch' && daemon) {
      log(
        `window closed; ${daemon.sessionCount()} active MCP session(s): continuing in headless mode`,
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
      .catch((err: unknown) => log('error shutting down the daemon:', err))
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
      log('headless mode: no window');
    } else {
      createMainWindow();
    }
  });
}
