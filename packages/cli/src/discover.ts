/**
 * Descoberta do daemon: lê `daemon.json` na pasta de dados, confere `/api/health`
 * e, se não houver daemon vivo, sobe um headless destacado.
 */
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
} from '@mockup/server';

export interface DaemonLocation {
  url: string;
  mcpUrl: string;
  wsUrl: string;
  port: number;
  /** `true` quando este processo acabou de iniciar o daemon. */
  spawned: boolean;
  pid?: number;
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
    if (health) return locationFromPort(info.port, false, info.pid);
    // Arquivo obsoleto (daemon morreu sem limpar): remove para não confundir.
    removeDaemonInfo(dataDir);
  }
  const port = resolvePort();
  const health = await checkHealth(`http://127.0.0.1:${port}`);
  if (health) return locationFromPort(port, false, health.pid);
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
  const child = spawn(process.execPath, [bin, '--headless', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, MOCKUP_DATA_DIR: getDataDir() },
  });
  child.unref();
  log(`daemon headless iniciado (pid ${child.pid}) na porta ${port}; aguardando...`);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHealth(url, 1000);
    if (health) return locationFromPort(port, true, child.pid);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`O daemon não respondeu em ${url}/api/health após ${timeoutMs} ms.`);
}

/** Garante um daemon disponível: usa o existente ou sobe um headless. */
export async function ensureDaemon(): Promise<DaemonLocation> {
  const found = await findDaemon();
  if (found) return found;
  return spawnHeadlessDaemon();
}
