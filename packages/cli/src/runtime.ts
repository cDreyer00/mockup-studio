/** Describes how this CLI is running: plain Node or Electron as Node (packaged app). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

export interface CliRuntime {
  kind: 'node' | 'electron';
  /** Executable that runs the script (`process.execPath`). */
  execPath: string;
  /** Real path of the CLI script (`bin.js` or the `mockup.mjs` bundle). */
  script: string;
  /** CLI version. */
  version: string;
  /** Embedded Node version (in Electron, its own Node's). */
  nodeVersion: string;
  /** Electron version (only `kind: 'electron'`). */
  electronVersion?: string;
}

export interface RuntimeSource {
  versions?: NodeJS.ProcessVersions;
  execPath?: string;
  argv1?: string;
  realpath?: (p: string) => string;
}

/** `true` when running inside Electron (with `ELECTRON_RUN_AS_NODE=1`). */
export function isElectronRuntime(versions: NodeJS.ProcessVersions = process.versions): boolean {
  return typeof versions.electron === 'string' && versions.electron !== '';
}

export function cliRuntime(src: RuntimeSource = {}): CliRuntime {
  const versions = src.versions ?? process.versions;
  const realpath = src.realpath ?? ((p: string) => fs.realpathSync(p));
  const argv1 = src.argv1 ?? process.argv[1];
  let script = argv1 ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin.js');
  try {
    script = realpath(script);
  } catch {
    script = path.resolve(script);
  }
  const electron = isElectronRuntime(versions);
  return {
    kind: electron ? 'electron' : 'node',
    execPath: src.execPath ?? process.execPath,
    script,
    version: VERSION,
    nodeVersion: versions.node,
    ...(electron ? { electronVersion: versions.electron } : {}),
  };
}
