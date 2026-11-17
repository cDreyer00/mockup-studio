/**
 * Daemon discovery: reads `daemon.json` in the data folder, checks `/api/health`
 * and, if there is no live daemon, starts a detached headless one. A headless Node daemon without render is
 * replaced by headless Electron when it is available.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkHealth,
  getDataDir,
  readDaemonInfo,
  removeDaemonInfo,
  resolvePort,
  takeOverDaemon,
  type DaemonInfo,
  type DaemonMode,
  type HealthInfo,
} from '@mockup/server';
import { locateElectron, spawnElectronHeadless, type ElectronLaunch } from './electron.js';

export interface DaemonLocation {
  url: string;
  mcpUrl: string;
  wsUrl: string;
  port: number;
  /** `true` when this process just started the daemon. */
  spawned: boolean;
  pid?: number;
  /** Daemon render engine (from health); `undefined` when unknown. */
  render?: boolean;
  /** Who started the daemon (from health); absent in old daemons. */
  mode?: DaemonMode;
}

/** Checks that the `/api/health` response comes from a Mockup Studio daemon (and not another service). */
export function isMockupHealth(h: unknown): h is HealthInfo {
  if (h === null || typeof h !== 'object') return false;
  const o = h as Record<string, unknown>;
  return o.ok === true && o.name === 'mockup-studio' && typeof o.version === 'string';
}

export function log(...args: unknown[]): void {
  // stdout belongs to the MCP protocol: logs always go to stderr.
  console.error('[mockup]', ...args);
}

function locationFromPort(
  port: number,
  spawned: boolean,
  pid?: number,
  extra: { render?: boolean; mode?: DaemonMode } = {},
): DaemonLocation {
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    mcpUrl: `${url}/mcp`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    port,
    spawned,
    pid,
    render: extra.render,
    mode: extra.mode,
  };
}

/** Looks for a live daemon: first via `daemon.json`, then via the configured port. */
export async function findDaemon(): Promise<DaemonLocation | null> {
  const dataDir = getDataDir();
  const info: DaemonInfo | null = readDaemonInfo(dataDir);
  if (info) {
    const health = await checkHealth(info.url);
    if (isMockupHealth(health)) return locationFromPort(info.port, false, info.pid, health);
    // Stale file (daemon died without cleaning up): remove it to avoid confusion.
    removeDaemonInfo(dataDir);
  }
  const port = resolvePort();
  const health = await checkHealth(`http://127.0.0.1:${port}`);
  if (isMockupHealth(health)) return locationFromPort(port, false, health.pid, health);
  return null;
}

export interface DaemonBinSource {
  env?: NodeJS.ProcessEnv;
  /** Folder of the current file (in the app bundle, next to `daemon.mjs`). */
  bundleDir?: string;
  exists?: (p: string) => boolean;
  /** Resolves `@mockup/server` (monorepo); may throw. */
  resolveServer?: () => string;
}

/**
 * Path of the Node daemon binary: `MOCKUP_DAEMON_BIN`, then `daemon.mjs` next to the bundle
 * of the CLI, then the `bin.js` of the `@mockup/server` package (monorepo).
 */
export function resolveDaemonBin(src: DaemonBinSource = {}): string {
  const env = src.env ?? process.env;
  const exists = src.exists ?? fs.existsSync;
  const fromEnv = env.MOCKUP_DAEMON_BIN;
  if (fromEnv && exists(fromEnv)) return fromEnv;
  const bundleDir = src.bundleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const beside = path.join(bundleDir, 'daemon.mjs');
  if (exists(beside)) return beside;
  try {
    const entry = src.resolveServer
      ? src.resolveServer()
      : createRequire(import.meta.url).resolve('@mockup/server');
    const bin = path.join(path.dirname(entry), 'bin.js');
    if (exists(bin)) return bin;
  } catch {
    /* no package (bundle) */
  }
  throw new Error(
    'daemon binary not found: set MOCKUP_DAEMON_BIN, put daemon.mjs next to the CLI ' +
      'or run `npm run build` (the @mockup/server package must be built).',
  );
}

/** Environment of the detached Node daemon; under Electron the executable only runs JS with ELECTRON_RUN_AS_NODE=1. */
export function daemonEnv(
  dataDir: string,
  base: NodeJS.ProcessEnv = process.env,
  electron: boolean = !!process.versions.electron,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MOCKUP_DATA_DIR: dataDir };
  if (electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/** Starts a detached headless daemon (survives this process) and waits for health. */
export async function spawnHeadlessDaemon(
  port = resolvePort(),
  timeoutMs = 20000,
  files: string[] = [],
): Promise<DaemonLocation> {
  const bin = resolveDaemonBin();
  const dataDir = getDataDir();
  let logFd: number | undefined;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    logFd = fs.openSync(path.join(dataDir, 'daemon.log'), 'a');
    fs.writeSync(
      logFd,
      `[mockup] ${new Date().toISOString()} starting headless daemon on port ${port}\n`,
    );
  } catch {
    logFd = undefined; // no log: the daemon runs with stdio discarded
  }
  const child = spawn(process.execPath, [bin, '--headless', '--port', String(port), ...files], {
    detached: true,
    stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    windowsHide: true,
    env: daemonEnv(dataDir),
  });
  if (logFd !== undefined) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignored */
    }
  }
  child.unref();
  log(`headless daemon started (pid ${child.pid}) on port ${port}; waiting...`);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHealth(url, 1000);
    if (isMockupHealth(health)) return locationFromPort(port, true, child.pid, health);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The daemon did not respond at ${url}/api/health after ${timeoutMs} ms.`);
}

/** Dependencies of `ensureDaemon` (injectable in tests). */
export interface EnsureDeps {
  locate: () => ElectronLaunch | null;
  spawnElectron: typeof spawnElectronHeadless;
  spawnNode: typeof spawnHeadlessDaemon;
  takeOver: typeof takeOverDaemon;
}

const defaultDeps: EnsureDeps = {
  locate: () => locateElectron(),
  spawnElectron: spawnElectronHeadless,
  spawnNode: spawnHeadlessDaemon,
  takeOver: takeOverDaemon,
};

/**
 * Live daemon without render and Electron is available: if the CLI started it (`headless` mode),
 * swaps it for a headless Electron, reopening the documents it had; if it is the user's
 * `mockup serve`, keeps it and says how to fix it. Any failure returns the original daemon (or a new Node one).
 */
async function upgradeDaemon(found: DaemonLocation, deps: EnsureDeps): Promise<DaemonLocation> {
  const electron = deps.locate();
  if (!electron) return found;
  if (found.mode !== 'headless') {
    log(
      `the daemon at ${found.url} (pid ${found.pid ?? '?'}) has no render engine and was not ` +
        'started by the CLI: screenshots and measured layout are unavailable. Stop it ' +
        '(`mockup stop` or Ctrl+C) and run again so the CLI starts Electron, ' +
        'or restart it with `mockup serve --render`.',
    );
    return found;
  }
  log('headless Node daemon without render: switching to headless Electron (with screenshots)...');
  const r = await deps.takeOver(found.url);
  if (!r.ok) {
    log(`could not stop the current daemon (${r.reason ?? 'unknown reason'}); keeping it.`);
    return (await findDaemon()) ?? found;
  }
  if (r.unsaved > 0)
    log(
      `${r.unsaved} document(s) without a file were closed during the switch (they were not saved).`,
    );
  try {
    const { pid } = await deps.spawnElectron(electron, found.port, 30000, r.paths);
    log(`Headless Electron ready (${electron.source}); ${r.paths.length} document(s) reopened`);
    return locationFromPort(found.port, true, pid, { render: true, mode: 'desktop' });
  } catch (e) {
    log(
      `could not start headless Electron (${e instanceof Error ? e.message : e}); ` +
        'falling back to the Node daemon: screenshots and measured layout will be unavailable.',
    );
    return (await findDaemon()) ?? deps.spawnNode(found.port, 20000, r.paths);
  }
}

/**
 * Ensures a daemon is available: uses the existing one or starts a headless one. Tries headless
 * Electron first (with render engine/screenshots); without Electron or if it fails, falls back to the plain Node daemon.
 * An already-live headless Node daemon (without render) is replaced by Electron when it is available.
 */
export async function ensureDaemon(deps: EnsureDeps = defaultDeps): Promise<DaemonLocation> {
  const found = await findDaemon();
  if (found) return found.render === false ? upgradeDaemon(found, deps) : found;
  const electron = deps.locate();
  if (electron) {
    const port = resolvePort();
    try {
      const { pid } = await deps.spawnElectron(electron, port);
      log(`Headless Electron ready (${electron.source}); screenshots available`);
      return locationFromPort(port, true, pid, { render: true, mode: 'desktop' });
    } catch (e) {
      log(
        `could not start headless Electron (${e instanceof Error ? e.message : e}); ` +
          'using the Node daemon: screenshots and measured layout will be unavailable.',
      );
      // another daemon may have taken the port in the meantime
      const again = await findDaemon();
      if (again) return again;
    }
  } else if (process.env.MOCKUP_NO_ELECTRON !== '1') {
    log(
      'Electron not found (set MOCKUP_DESKTOP_EXE or install the app): ' +
        'using the Node daemon, without screenshots.',
    );
  }
  return deps.spawnNode();
}
