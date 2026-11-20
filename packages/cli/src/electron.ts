/**
 * Locates and starts the desktop app (Electron) in headless mode: it embeds the daemon and the render
 * engine (screenshots). Without Electron, the CLI falls back to the plain Node daemon (no screenshots).
 */
import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { checkHealth, getDataDir } from '@mockup/server';

export interface ElectronLaunch {
  /** Executable (packaged app or Electron binary). */
  exe: string;
  /** Arguments before the app options (app path in dev). */
  args: string[];
  /** Where it came from (for logging). */
  source: 'MOCKUP_DESKTOP_EXE' | 'embedded' | 'installed' | 'dev';
}

const PRODUCT_NAME = 'Mockup Studio';

const UNINSTALL = String.raw`Software\Microsoft\Windows\CurrentVersion\Uninstall`;

/** `HKEY_...` lines of a `reg query` output (the keys found). */
export function parseRegKeys(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^HKEY_/i.test(l));
}

/** `InstallLocation` value (REG_SZ/REG_EXPAND_SZ) from a `reg query` output, or null. */
export function parseInstallLocation(out: string): string | null {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (m?.[1]) return m[1].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

function reg(args: string[]): string {
  const r = spawnSync('reg', args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return r.status === 0 ? r.stdout : '';
}

/**
 * Install folders written by the NSIS installer in the registry (`InstallLocation` of the
 * uninstall key whose display name contains "Mockup Studio"): works for a custom folder.
 * HKCU first (per-user install), then HKLM.
 */
export function registryInstallDirs(run: (args: string[]) => string = reg): string[] {
  const dirs: string[] = [];
  const roots = [
    `HKCU\\${UNINSTALL}`,
    `HKLM\\${UNINSTALL}`,
    String.raw`HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
  ];
  for (const root of roots) {
    for (const key of parseRegKeys(run(['query', root, '/s', '/f', PRODUCT_NAME, '/d']))) {
      const dir = parseInstallLocation(run(['query', key, '/v', 'InstallLocation']));
      if (dir && !dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Looks for the app: (1) MOCKUP_DESKTOP_EXE, (1b) the process itself when it runs as Node inside
 * Electron (packaged app: `process.execPath` is the app), (2) registered install (custom folder),
 * (3) default per-user NSIS install, (4) monorepo package + electron.
 */
export function locateElectron(
  env: NodeJS.ProcessEnv = process.env,
  installDirs: () => string[] = registryInstallDirs,
  self: { versions: NodeJS.ProcessVersions; execPath: string } = process,
): ElectronLaunch | null {
  if (env.MOCKUP_NO_ELECTRON === '1') return null;

  const fromEnv = env.MOCKUP_DESKTOP_EXE;
  if (fromEnv && fs.existsSync(fromEnv))
    return { exe: fromEnv, args: [], source: 'MOCKUP_DESKTOP_EXE' };

  if (self.versions.electron) return { exe: self.execPath, args: [], source: 'embedded' };

  if (process.platform === 'win32') {
    for (const dir of installDirs()) {
      const exe = path.join(dir, `${PRODUCT_NAME}.exe`);
      if (fs.existsSync(exe)) return { exe, args: [], source: 'installed' };
    }
  }

  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const exe = path.join(env.LOCALAPPDATA, 'Programs', PRODUCT_NAME, `${PRODUCT_NAME}.exe`);
    if (fs.existsSync(exe)) return { exe, args: [], source: 'installed' };
  }

  try {
    const req = createRequire(import.meta.url);
    const appDir = path.dirname(req.resolve('@mockup/desktop/package.json'));
    if (!fs.existsSync(path.join(appDir, 'out', 'main', 'index.js'))) return null;
    // In Node, `require('electron')` returns the executable path.
    const electronPath = createRequire(path.join(appDir, 'package.json'))('electron') as unknown;
    if (typeof electronPath === 'string' && fs.existsSync(electronPath))
      return { exe: electronPath, args: [appDir], source: 'dev' };
  } catch {
    /* no desktop/electron package installed */
  }
  return null;
}

/**
 * Electron environment: never inherits ELECTRON_RUN_AS_NODE (it would make the exe run as plain Node).
 * `MOCKUP_DATA_DIR` only reaches the app if the user set it: forcing it would change `userData` and the
 * single-instance lock, and the headless one would become a second instance next to the open app.
 */
export function electronEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * App options for the windowless instance. `--mockup-headless`, not `--headless`: Chromium treats the
 * latter as its own headless switch, and the app could never show a window later (second launch).
 */
export function electronArgs(l: ElectronLaunch, port: number, files: string[] = []): string[] {
  return [...l.args, '--mockup-headless', '--port', String(port), ...files];
}

/**
 * Starts the detached headless Electron and waits for `/api/health` with `render: true`.
 * Throws if the process exits first or the time runs out (the caller falls back to the Node daemon).
 */
export async function spawnElectronHeadless(
  l: ElectronLaunch,
  port: number,
  timeoutMs = 30000,
  files: string[] = [],
): Promise<{ pid?: number }> {
  const dataDir = getDataDir();
  let logFd: number | undefined;
  try {
    logFd = fs.openSync(path.join(dataDir, 'daemon.log'), 'a');
    fs.writeSync(
      logFd,
      `[mockup] ${new Date().toISOString()} starting headless Electron (${l.source}) on port ${port}\n`,
    );
  } catch {
    logFd = undefined;
  }
  const child: ChildProcess = spawn(l.exe, electronArgs(l, port, files), {
    detached: true,
    stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    // No `windowsHide`: Electron is a GUI app (no console to hide), and SW_HIDE in its STARTUPINFO
    // would turn the first window it shows later (the app opened again) into a hidden one.
    env: electronEnv(),
  });
  if (logFd !== undefined) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignored */
    }
  }
  let exited: number | null = null;
  child.once('exit', (code) => (exited = code ?? -1));
  child.once('error', () => (exited = -1));
  child.unref();

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`Electron exited before responding (code ${exited})`);
    const h = await checkHealth(url, 1000);
    if (h?.ok && h.name === 'mockup-studio' && h.render) return { pid: child.pid };
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    if (child.pid) process.kill(child.pid);
  } catch {
    /* already exited */
  }
  throw new Error(
    `Electron did not respond at ${url}/api/health (render: true) after ${timeoutMs} ms`,
  );
}

/** `mockup serve --render`: headless Electron in the foreground (inherited stdio); returns the exit code. */
export function runElectronForeground(
  l: ElectronLaunch,
  port: number,
  files: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(l.exe, electronArgs(l, port, files), {
      stdio: 'inherit',
      env: electronEnv(),
    });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    process.once('SIGINT', forward('SIGINT'));
    process.once('SIGTERM', forward('SIGTERM'));
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 0));
  });
}
