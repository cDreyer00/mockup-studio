/** `mockup install-cli` / `uninstall-cli`: shim `mockup` numa pasta própria e entrada no PATH do usuário. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cliRuntime, type CliRuntime } from './runtime.js';

/** Marcador que identifica um shim nosso (nas primeiras linhas). */
export const SHIM_MARKER = 'mockup-studio-shim';

/* ---------- PATH (lógica pura) ---------- */

function splitPath(list: string): string[] {
  return list
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Chave de comparação: sem barra final e sem diferença de caixa. */
function pathKey(entry: string): string {
  return entry
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

/** Acrescenta `dir` ao fim da lista (separada por `;`) se ainda não estiver nela. */
export function addToPathList(list: string, dir: string): string {
  const entries = splitPath(list);
  if (!entries.some((e) => pathKey(e) === pathKey(dir))) entries.push(dir);
  return entries.join(';');
}

/** Remove `dir` da lista (todas as ocorrências), mantendo a ordem das demais. */
export function removeFromPathList(list: string, dir: string): string {
  return splitPath(list)
    .filter((e) => pathKey(e) !== pathKey(dir))
    .join(';');
}

/* ---------- pastas e shim ---------- */

export function defaultBinDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return path.join(base, 'MockupStudio', 'bin');
  }
  return path.join(home, '.local', 'bin');
}

export function shimName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'mockup.cmd' : 'mockup';
}

export function shimPath(
  binDir: string = defaultBinDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(binDir, shimName(platform));
}

/** Conteúdo do shim que reproduz o runtime atual. */
export function buildShim(r: CliRuntime, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const lines = ['@echo off', `rem ${SHIM_MARKER}`, 'setlocal'];
    if (r.kind === 'electron') lines.push('set ELECTRON_RUN_AS_NODE=1');
    lines.push(`"${r.execPath}" "${r.script}" %*`, 'exit /b %ERRORLEVEL%');
    return lines.join('\r\n') + '\r\n';
  }
  const env = r.kind === 'electron' ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `#!/bin/sh\n# ${SHIM_MARKER}\nexec ${env}"${r.execPath}" "${r.script}" "$@"\n`;
}

function isOurShim(file: string): boolean {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .slice(0, 5)
      .some((l) => l.includes(SHIM_MARKER));
  } catch {
    return false;
  }
}

/* ---------- PowerShell (registro do Windows) ---------- */

export interface PsResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Executa um script PowerShell passando valores por variáveis de ambiente. */
export type PsRunner = (script: string, env: Record<string, string>) => PsResult;

export const psRunner: PsRunner = (script, env) => {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, ...env } },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
};

// Saída em UTF-8: com a página de código OEM padrão do console, entradas do PATH com acentos
// voltariam corrompidas e seriam gravadas assim. A escrita recebe o valor por variável de ambiente.
export const READ_PATH_SCRIPT = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$false)
try { [Console]::Out.Write([string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) } finally { $k.Close() }`;

export const WRITE_PATH_SCRIPT = `$ErrorActionPreference='Stop'
$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
try { $k.SetValue('Path',$env:MOCKUP_NEW_PATH,[Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $k.Close() }
[Environment]::SetEnvironmentVariable('MOCKUP_STUDIO_PATH_REFRESH','1','User')
[Environment]::SetEnvironmentVariable('MOCKUP_STUDIO_PATH_REFRESH',$null,'User')`;

function readUserPath(ps: PsRunner): string {
  const r = ps(READ_PATH_SCRIPT, {});
  if (r.status !== 0) throw new Error(`não foi possível ler o PATH do usuário: ${r.stderr.trim()}`);
  return r.stdout.replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '');
}

function writeUserPath(ps: PsRunner, value: string): void {
  const r = ps(WRITE_PATH_SCRIPT, { MOCKUP_NEW_PATH: value });
  if (r.status !== 0)
    throw new Error(`não foi possível gravar o PATH do usuário: ${r.stderr.trim()}`);
}

/* ---------- comandos ---------- */

export interface InstallDeps {
  runtime: CliRuntime;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  ps: PsRunner;
}

export function defaultInstallDeps(): InstallDeps {
  return {
    runtime: cliRuntime(),
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    ps: psRunner,
  };
}

export interface InstallResult {
  code: 0 | 1;
  lines: string[];
}

export function installCli(
  opts: { binDir?: string } = {},
  deps: InstallDeps = defaultInstallDeps(),
): InstallResult {
  const lines: string[] = [];
  const binDir = path.resolve(opts.binDir ?? defaultBinDir(deps.env, deps.platform, deps.home));
  const file = shimPath(binDir, deps.platform);
  try {
    if (fs.existsSync(file) && !isOurShim(file))
      throw new Error(`${file} já existe e não é do Mockup Studio; use --bin-dir ou remova-o.`);
    fs.mkdirSync(binDir, { recursive: true });
    const existed = fs.existsSync(file);
    fs.writeFileSync(file, buildShim(deps.runtime, deps.platform), 'utf8');
    if (deps.platform !== 'win32') fs.chmodSync(file, 0o755);
    lines.push(`${existed ? 'atualizado' : 'criado'}: ${file}`);

    if (deps.platform === 'win32') {
      const current = readUserPath(deps.ps);
      const next = addToPathList(current, binDir);
      if (next === current) lines.push(`${binDir} já está no PATH do usuário.`);
      else {
        writeUserPath(deps.ps, next);
        lines.push(`${binDir} adicionado ao PATH do usuário.`);
      }
      lines.push('Abra um terminal novo para o comando `mockup` ficar disponível.');
    } else {
      const inPath = (deps.env.PATH ?? '')
        .split(path.delimiter)
        .some((e) => pathKey(e) === pathKey(binDir));
      lines.push(
        inPath
          ? 'Abra um terminal novo se `mockup` ainda não for encontrado.'
          : `Adicione ${binDir} ao PATH (ex.: no ~/.profile) e abra um terminal novo.`,
      );
    }
    return { code: 0, lines };
  } catch (e) {
    lines.push(`erro: ${e instanceof Error ? e.message : String(e)}`);
    return { code: 1, lines };
  }
}

export function uninstallCli(
  opts: { binDir?: string } = {},
  deps: InstallDeps = defaultInstallDeps(),
): InstallResult {
  const lines: string[] = [];
  const binDir = path.resolve(opts.binDir ?? defaultBinDir(deps.env, deps.platform, deps.home));
  const file = shimPath(binDir, deps.platform);
  try {
    if (fs.existsSync(file)) {
      if (isOurShim(file)) {
        fs.rmSync(file);
        lines.push(`removido: ${file}`);
      } else lines.push(`${file} não é do Mockup Studio: mantido.`);
    } else lines.push(`${file} não existe.`);
    try {
      if (fs.readdirSync(binDir).length === 0) {
        fs.rmdirSync(binDir);
        lines.push(`pasta removida: ${binDir}`);
      }
    } catch {
      /* pasta inexistente */
    }
    if (deps.platform === 'win32') {
      const current = readUserPath(deps.ps);
      const next = removeFromPathList(current, binDir);
      if (next === current) lines.push(`${binDir} não estava no PATH do usuário.`);
      else {
        writeUserPath(deps.ps, next);
        lines.push(`${binDir} removido do PATH do usuário.`);
      }
      lines.push('Abra um terminal novo para o PATH atualizado valer.');
    }
    return { code: 0, lines };
  } catch (e) {
    lines.push(`erro: ${e instanceof Error ? e.message : String(e)}`);
    return { code: 1, lines };
  }
}
