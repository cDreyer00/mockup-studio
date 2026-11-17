/** Descreve como este CLI está rodando: Node puro ou o Electron como Node (app empacotado). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

export interface CliRuntime {
  kind: 'node' | 'electron';
  /** Executável que roda o script (`process.execPath`). */
  execPath: string;
  /** Caminho real do script do CLI (`bin.js` ou o bundle `mockup.mjs`). */
  script: string;
  /** Versão do CLI. */
  version: string;
  /** Versão do Node embutido (no Electron, a do Node dele). */
  nodeVersion: string;
  /** Versão do Electron (só `kind: 'electron'`). */
  electronVersion?: string;
}

export interface RuntimeSource {
  versions?: NodeJS.ProcessVersions;
  execPath?: string;
  argv1?: string;
  realpath?: (p: string) => string;
}

/** `true` quando rodando dentro do Electron (com `ELECTRON_RUN_AS_NODE=1`). */
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
