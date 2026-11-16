/**
 * Descoberta do daemon: lê `daemon.json` na pasta de dados, confere `/api/health`
 * e, se não houver daemon vivo, sobe um headless destacado. Um daemon Node headless sem render é
 * trocado pelo Electron headless quando ele está disponível.
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
  /** `true` quando este processo acabou de iniciar o daemon. */
  spawned: boolean;
  pid?: number;
  /** Motor de render do daemon (do health); `undefined` quando não se sabe. */
  render?: boolean;
  /** Quem iniciou o daemon (do health); ausente em daemons antigos. */
  mode?: DaemonMode;
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

/** Procura um daemon vivo: primeiro pelo `daemon.json`, depois pela porta configurada. */
export async function findDaemon(): Promise<DaemonLocation | null> {
  const dataDir = getDataDir();
  const info: DaemonInfo | null = readDaemonInfo(dataDir);
  if (info) {
    const health = await checkHealth(info.url);
    if (isMockupHealth(health)) return locationFromPort(info.port, false, info.pid, health);
    // Arquivo obsoleto (daemon morreu sem limpar): remove para não confundir.
    removeDaemonInfo(dataDir);
  }
  const port = resolvePort();
  const health = await checkHealth(`http://127.0.0.1:${port}`);
  if (isMockupHealth(health)) return locationFromPort(port, false, health.pid, health);
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
      `[mockup] ${new Date().toISOString()} iniciando daemon headless na porta ${port}\n`,
    );
  } catch {
    logFd = undefined; // sem log: o daemon roda com stdio descartado
  }
  const child = spawn(process.execPath, [bin, '--headless', '--port', String(port), ...files], {
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
    if (isMockupHealth(health)) return locationFromPort(port, true, child.pid, health);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`O daemon não respondeu em ${url}/api/health após ${timeoutMs} ms.`);
}

/** Dependências de `ensureDaemon` (injetáveis nos testes). */
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
 * Daemon vivo sem render e há Electron disponível: se foi o CLI que o iniciou (modo `headless`),
 * troca por um Electron headless reabrindo os documentos que ele tinha; se é um `mockup serve` do
 * usuário, mantém e avisa como resolver. Qualquer falha devolve o daemon original (ou um Node novo).
 */
async function upgradeDaemon(found: DaemonLocation, deps: EnsureDeps): Promise<DaemonLocation> {
  const electron = deps.locate();
  if (!electron) return found;
  if (found.mode !== 'headless') {
    log(
      `o daemon em ${found.url} (pid ${found.pid ?? '?'}) não tem motor de render e não foi ` +
        'iniciado pelo CLI: screenshot e layout medido ficam indisponíveis. Encerre-o ' +
        '(`mockup stop` ou Ctrl+C) e rode de novo para o CLI subir o Electron, ' +
        'ou reinicie-o com `mockup serve --render`.',
    );
    return found;
  }
  log('daemon Node headless sem render: trocando pelo Electron headless (com screenshot)...');
  const r = await deps.takeOver(found.url);
  if (!r.ok) {
    log(
      `não foi possível encerrar o daemon atual (${r.reason ?? 'motivo desconhecido'}); mantendo-o.`,
    );
    return (await findDaemon()) ?? found;
  }
  if (r.unsaved > 0)
    log(`${r.unsaved} documento(s) sem arquivo foram fechados na troca (não estavam salvos).`);
  try {
    const { pid } = await deps.spawnElectron(electron, found.port, 30000, r.paths);
    log(
      `Electron headless pronto (${electron.source}); ${r.paths.length} documento(s) reaberto(s)`,
    );
    return locationFromPort(found.port, true, pid, { render: true, mode: 'desktop' });
  } catch (e) {
    log(
      `não foi possível subir o Electron headless (${e instanceof Error ? e.message : e}); ` +
        'voltando ao daemon Node: screenshot e layout medido ficarão indisponíveis.',
    );
    return (await findDaemon()) ?? deps.spawnNode(found.port, 20000, r.paths);
  }
}

/**
 * Garante um daemon disponível: usa o existente ou sobe um headless. Tenta primeiro o Electron
 * headless (com motor de render/screenshot); sem Electron ou se falhar, cai para o daemon Node puro.
 * Um daemon Node headless já vivo (sem render) é trocado pelo Electron quando ele está disponível.
 */
export async function ensureDaemon(deps: EnsureDeps = defaultDeps): Promise<DaemonLocation> {
  const found = await findDaemon();
  if (found) return found.render === false ? upgradeDaemon(found, deps) : found;
  const electron = deps.locate();
  if (electron) {
    const port = resolvePort();
    try {
      const { pid } = await deps.spawnElectron(electron, port);
      log(`Electron headless pronto (${electron.source}); screenshot disponível`);
      return locationFromPort(port, true, pid, { render: true, mode: 'desktop' });
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
  return deps.spawnNode();
}
