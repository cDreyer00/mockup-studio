/**
 * Localiza e sobe o app desktop (Electron) em modo headless: ele embute o daemon e o motor de
 * render (screenshot). Sem Electron, o CLI cai para o daemon Node puro (sem screenshot).
 */
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { checkHealth, getDataDir } from '@mockup/server';

export interface ElectronLaunch {
  /** Executável (app empacotado ou binário do Electron). */
  exe: string;
  /** Argumentos antes das opções do app (caminho do app em dev). */
  args: string[];
  /** De onde veio (para log). */
  source: 'MOCKUP_DESKTOP_EXE' | 'instalado' | 'dev';
}

const PRODUCT_NAME = 'Mockup Studio';

/** Procura o app: (1) MOCKUP_DESKTOP_EXE, (2) instalação NSIS por usuário, (3) pacote do monorepo + electron. */
export function locateElectron(env: NodeJS.ProcessEnv = process.env): ElectronLaunch | null {
  if (env.MOCKUP_NO_ELECTRON === '1') return null;

  const fromEnv = env.MOCKUP_DESKTOP_EXE;
  if (fromEnv && fs.existsSync(fromEnv))
    return { exe: fromEnv, args: [], source: 'MOCKUP_DESKTOP_EXE' };

  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const exe = path.join(env.LOCALAPPDATA, 'Programs', PRODUCT_NAME, `${PRODUCT_NAME}.exe`);
    if (fs.existsSync(exe)) return { exe, args: [], source: 'instalado' };
  }

  try {
    const req = createRequire(import.meta.url);
    const appDir = path.dirname(req.resolve('@mockup/desktop/package.json'));
    if (!fs.existsSync(path.join(appDir, 'out', 'main', 'index.js'))) return null;
    // No Node, `require('electron')` devolve o caminho do executável.
    const electronPath = createRequire(path.join(appDir, 'package.json'))('electron') as unknown;
    if (typeof electronPath === 'string' && fs.existsSync(electronPath))
      return { exe: electronPath, args: [appDir], source: 'dev' };
  } catch {
    /* sem pacote desktop/electron instalado */
  }
  return null;
}

/** Ambiente do Electron: nunca herda ELECTRON_RUN_AS_NODE (faria o exe rodar como Node puro). */
export function electronEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MOCKUP_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function electronArgs(l: ElectronLaunch, port: number, files: string[] = []): string[] {
  return [...l.args, '--headless', '--port', String(port), ...files];
}

/**
 * Sobe o Electron headless destacado e espera `/api/health` com `render: true`.
 * Lança se o processo sair antes ou o tempo esgotar (o chamador cai para o daemon Node).
 */
export async function spawnElectronHeadless(
  l: ElectronLaunch,
  port: number,
  timeoutMs = 30000,
): Promise<{ pid?: number }> {
  const dataDir = getDataDir();
  let logFd: number | undefined;
  try {
    logFd = fs.openSync(path.join(dataDir, 'daemon.log'), 'a');
    fs.writeSync(
      logFd,
      `[mockup] ${new Date().toISOString()} iniciando Electron headless (${l.source}) na porta ${port}\n`,
    );
  } catch {
    logFd = undefined;
  }
  const child: ChildProcess = spawn(l.exe, electronArgs(l, port), {
    detached: true,
    stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    windowsHide: true,
    env: electronEnv(dataDir),
  });
  if (logFd !== undefined) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignorado */
    }
  }
  let exited: number | null = null;
  child.once('exit', (code) => (exited = code ?? -1));
  child.once('error', () => (exited = -1));
  child.unref();

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null)
      throw new Error(`o Electron encerrou antes de responder (código ${exited})`);
    const h = await checkHealth(url, 1000);
    if (h?.ok && h.name === 'mockup-studio' && h.render) return { pid: child.pid };
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    if (child.pid) process.kill(child.pid);
  } catch {
    /* já encerrou */
  }
  throw new Error(
    `o Electron não respondeu em ${url}/api/health (render: true) após ${timeoutMs} ms`,
  );
}

/** `mockup serve --render`: Electron headless em primeiro plano (stdio herdado); devolve o código de saída. */
export function runElectronForeground(
  l: ElectronLaunch,
  port: number,
  files: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(l.exe, electronArgs(l, port, files), {
      stdio: 'inherit',
      env: electronEnv(getDataDir()),
    });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    process.once('SIGINT', forward('SIGINT'));
    process.once('SIGTERM', forward('SIGTERM'));
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 0));
  });
}
