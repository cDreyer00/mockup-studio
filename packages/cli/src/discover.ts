/**
 * Descoberta do daemon: lê `daemon.json` na pasta de dados, confere `/api/health`
 * e, se não houver daemon vivo, sobe um headless destacado.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  checkHealth,
  getDataDir,
  readDaemonInfo,
  removeDaemonInfo,
  resolvePort,
  type DaemonInfo,
  type HealthInfo,
} from '@mockup/server';
import { locateElectron, spawnElectronHeadless } from './electron.js';

export interface DaemonLocation {
  url: string;
  mcpUrl: string;
  wsUrl: string;
  port: number;
  /** `true` quando este processo acabou de iniciar o daemon. */
  spawned: boolean;
  pid?: number;
}

/** Confere que a resposta de `/api/health` é de um daemon do Mockup Studio (e não de outro serviço). */
export function isMockupHealth(h: unknown): h is HealthInfo {
  if (h === null || typeof h !== 'object') return false;
  const o = h as Record<string, unknown>;
  return o.ok === true && o.name === 'mockup-studio' && typeof o.version === 'string';
}

export function log(...args: unknown[]): void {
  // stdout pertence ao protocolo MCP: logs sempre em stderr.
  console.error('[mockup]', ...args);
}

function locationFromPort(port: number, spawned: boolean, pid?: number): DaemonLocation {
  const url = `http://127.0.0.1:${port}`;
  return { url, mcpUrl: `${url}/mcp`, wsUrl: `ws://127.0.0.1:${port}/ws`, port, spawned, pid };
}

/** Procura um daemon vivo: primeiro pelo `daemon.json`, depois pela porta configurada. */
export async function findDaemon(): Promise<DaemonLocation | null> {
  const dataDir = getDataDir();
  const info: DaemonInfo | null = readDaemonInfo(dataDir);
  if (info) {
    const health = await checkHealth(info.url);
    if (isMockupHealth(health)) return locationFromPort(info.port, false, info.pid);
    // Arquivo obsoleto (daemon morreu sem limpar): remove para não confundir.
    removeDaemonInfo(dataDir);
  }
  const port = resolvePort();
  const health = await checkHealth(`http://127.0.0.1:${port}`);
  if (isMockupHealth(health)) return locationFromPort(port, false, health.pid);
  return null;
}

function resolveDaemonBin(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@mockup/server');
  return path.join(path.dirname(entry), 'bin.js');
}

/** Sobe um daemon headless destacado (sobrevive ao fim deste processo) e espera o health. */
export async function spawnHeadlessDaemon(
  port = resolvePort(),
  timeoutMs = 20000,
): Promise<DaemonLocation> {
  const bin = resolveDaemonBin();
  const dataDir = getDataDir();
  let logFd: number | undefined;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    logFd = fs.openSync(path.join(dataDir, 'daemon.log'), 'a');
    fs.writeSync(
      logFd,
      `[mockup] ${new Date().toISOString()} iniciando daemon headless na porta ${port}\n`,
    );
  } catch {
    logFd = undefined; // sem log: o daemon roda com stdio descartado
  }
  const child = spawn(process.execPath, [bin, '--headless', '--port', String(port)], {
    detached: true,
    stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...process.env, MOCKUP_DATA_DIR: dataDir },
  });
  if (logFd !== undefined) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignorado */
    }
  }
  child.unref();
  log(`daemon headless iniciado (pid ${child.pid}) na porta ${port}; aguardando...`);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHealth(url, 1000);
    if (isMockupHealth(health)) return locationFromPort(port, true, child.pid);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`O daemon não respondeu em ${url}/api/health após ${timeoutMs} ms.`);
}

/**
 * Garante um daemon disponível: usa o existente ou sobe um headless. Tenta primeiro o Electron
 * headless (com motor de render/screenshot); sem Electron ou se falhar, cai para o daemon Node puro.
 */
export async function ensureDaemon(): Promise<DaemonLocation> {
  const found = await findDaemon();
  if (found) return found;
  const electron = locateElectron();
  if (electron) {
    const port = resolvePort();
    try {
      const { pid } = await spawnElectronHeadless(electron, port);
      log(`Electron headless pronto (${electron.source}); screenshot disponível`);
      return locationFromPort(port, true, pid);
    } catch (e) {
      log(
        `não foi possível subir o Electron headless (${e instanceof Error ? e.message : e}); ` +
          'usando o daemon Node: screenshot e layout medido ficarão indisponíveis.',
      );
      // outro daemon pode ter assumido a porta enquanto isso
      const again = await findDaemon();
      if (again) return again;
    }
  } else if (process.env.MOCKUP_NO_ELECTRON !== '1') {
    log(
      'Electron não encontrado (defina MOCKUP_DESKTOP_EXE ou instale o app): ' +
        'usando o daemon Node, sem screenshot.',
    );
  }
  return spawnHeadlessDaemon();
}
