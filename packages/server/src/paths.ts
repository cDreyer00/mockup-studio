import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4747;

export const DOCUMENT_EXT = '.mockup.json';

/**
 * Normalizes a document path to end in `.mockup.json`:
 * `foo.mockup.json` is kept; `foo.json` becomes `foo.mockup.json`; `foo` becomes `foo.mockup.json`.
 */
export function normalizeDocumentPath(p: string): string {
  const abs = path.resolve(p);
  if (abs.toLowerCase().endsWith(DOCUMENT_EXT)) return abs;
  if (abs.toLowerCase().endsWith('.json')) return abs.slice(0, -'.json'.length) + DOCUMENT_EXT;
  return abs + DOCUMENT_EXT;
}

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  url: string;
  mcpUrl: string;
  wsUrl: string;
}

export function getDataDir(): string {
  let dir = process.env.MOCKUP_DATA_DIR;
  if (!dir) {
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      dir = path.join(process.env.LOCALAPPDATA, 'MockupStudio');
    } else {
      dir = path.join(os.homedir(), '.mockup-studio');
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo, dataDir: string = getDataDir()): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'daemon.json'), JSON.stringify(info, null, 2), 'utf8');
}

export function readDaemonInfo(dataDir: string = getDataDir()): DaemonInfo | null {
  return readJson<DaemonInfo>(path.join(dataDir, 'daemon.json'));
}

/** Removes daemon.json. With `onlyIfPid`, only removes if the recorded pid is the same (another daemon may have taken over the file). */
export function removeDaemonInfo(dataDir: string = getDataDir(), onlyIfPid?: number): void {
  try {
    if (onlyIfPid !== undefined) {
      const cur = readDaemonInfo(dataDir);
      if (cur && cur.pid !== onlyIfPid) return;
    }
    fs.rmSync(path.join(dataDir, 'daemon.json'), { force: true });
  } catch {
    /* ignored */
  }
}

const MAX_RECENT = 20;

export function readRecent(dataDir: string = getDataDir()): string[] {
  const list = readJson<unknown>(path.join(dataDir, 'recent.json'));
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

export function addRecent(filePath: string, dataDir: string = getDataDir()): void {
  const list = [filePath, ...readRecent(dataDir).filter((p) => p !== filePath)].slice(
    0,
    MAX_RECENT,
  );
  try {
    fs.writeFileSync(path.join(dataDir, 'recent.json'), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* ignored */
  }
}

/** Removes a path from the recents (resolved; case-insensitive on Windows). */
export function removeRecent(filePath: string, dataDir: string = getDataDir()): void {
  const abs = path.resolve(filePath);
  const same = (p: string): boolean =>
    process.platform === 'win32'
      ? path.resolve(p).toLowerCase() === abs.toLowerCase()
      : path.resolve(p) === abs;
  const list = readRecent(dataDir);
  const next = list.filter((p) => !same(p));
  if (next.length === list.length) return;
  try {
    fs.writeFileSync(path.join(dataDir, 'recent.json'), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    /* ignored */
  }
}

export function readConfig(dataDir: string = getDataDir()): { port?: number } {
  return readJson<{ port?: number }>(path.join(dataDir, 'config.json')) ?? {};
}

export function resolvePort(cli?: number): number {
  if (cli !== undefined && cli !== null) return cli;
  const env = process.env.MOCKUP_PORT ? Number(process.env.MOCKUP_PORT) : NaN;
  if (Number.isInteger(env) && env >= 0) return env;
  const cfg = readConfig().port;
  if (typeof cfg === 'number') return cfg;
  return DEFAULT_PORT;
}
