/** `mockup install-cli` / `uninstall-cli`: `mockup` shim in its own folder and an entry in the user PATH. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cliRuntime, type CliRuntime } from './runtime.js';

/** Marker that identifies one of our shims (in the first lines). */
export const SHIM_MARKER = 'mockup-studio-shim';

/* ---------- PATH (pure logic) ---------- */

function splitPath(list: string): string[] {
  return list
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Comparison key: no trailing slash and case-insensitive. */
function pathKey(entry: string): string {
  return entry
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

/** Tells whether `dir` is already in the list (compared by `pathKey`). */
function hasInPathList(list: string, dir: string): boolean {
  return splitPath(list).some((e) => pathKey(e) === pathKey(dir));
}

/** Appends `dir` to the end of the list (separated by `;`) if it is not already there. */
export function addToPathList(list: string, dir: string): string {
  const entries = splitPath(list);
  if (!entries.some((e) => pathKey(e) === pathKey(dir))) entries.push(dir);
  return entries.join(';');
}

/** Removes `dir` from the list (all occurrences), keeping the order of the others. */
export function removeFromPathList(list: string, dir: string): string {
  return splitPath(list)
    .filter((e) => pathKey(e) !== pathKey(dir))
    .join(';');
}

/* ---------- folders and shim ---------- */

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

/** Content of the shim that reproduces the current runtime. */
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

/* ---------- PowerShell (Windows registry) ---------- */

export interface PsResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Runs a PowerShell script, passing values through environment variables. */
export type PsRunner = (script: string, env: Record<string, string>) => PsResult;

export const psRunner: PsRunner = (script, env) => {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, ...env } },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
};

// UTF-8 output: with the console's default OEM code page, PATH entries with accents
// would come back corrupted and be written that way. The write receives the value through an environment variable.
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
  if (r.status !== 0) throw new Error(`could not read the user PATH: ${r.stderr.trim()}`);
  return r.stdout.replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '');
}

function writeUserPath(ps: PsRunner, value: string): void {
  const r = ps(WRITE_PATH_SCRIPT, { MOCKUP_NEW_PATH: value });
  if (r.status !== 0) throw new Error(`could not write the user PATH: ${r.stderr.trim()}`);
}

/* ---------- commands ---------- */

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
  // The portable executable (electron-builder `portable`) extracts to a temporary folder on each
  // run: a shim pointing to it breaks as soon as the app closes.
  if (deps.env.PORTABLE_EXECUTABLE_DIR)
    return {
      code: 1,
      lines: [
        'error: the portable version runs from a temporary folder that disappears when the app closes; the',
        '`mockup` command installed by it would stop working. Use the installer (MockupStudio-Setup) or',
        'install the CLI through Node (`npm link` in the repository).',
      ],
    };
  const lines: string[] = [];
  const binDir = path.resolve(opts.binDir ?? defaultBinDir(deps.env, deps.platform, deps.home));
  const file = shimPath(binDir, deps.platform);
  try {
    if (fs.existsSync(file) && !isOurShim(file))
      throw new Error(
        `${file} already exists and is not from Mockup Studio; use --bin-dir or remove it.`,
      );
    fs.mkdirSync(binDir, { recursive: true });
    const existed = fs.existsSync(file);
    fs.writeFileSync(file, buildShim(deps.runtime, deps.platform), 'utf8');
    if (deps.platform !== 'win32') fs.chmodSync(file, 0o755);
    lines.push(`${existed ? 'updated' : 'created'}: ${file}`);

    if (deps.platform === 'win32') {
      const current = readUserPath(deps.ps);
      if (hasInPathList(current, binDir)) lines.push(`${binDir} is already in the user PATH.`);
      else {
        writeUserPath(deps.ps, addToPathList(current, binDir));
        lines.push(`${binDir} added to the user PATH.`);
      }
      lines.push('Open a new terminal for the `mockup` command to become available.');
    } else {
      const inPath = (deps.env.PATH ?? '')
        .split(path.delimiter)
        .some((e) => pathKey(e) === pathKey(binDir));
      lines.push(
        inPath
          ? 'Open a new terminal if `mockup` is still not found.'
          : `Add ${binDir} to the PATH (e.g. in ~/.profile) and open a new terminal.`,
      );
    }
    return { code: 0, lines };
  } catch (e) {
    lines.push(`error: ${e instanceof Error ? e.message : String(e)}`);
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
        lines.push(`removed: ${file}`);
      } else lines.push(`${file} is not from Mockup Studio: kept.`);
    } else lines.push(`${file} does not exist.`);
    try {
      if (fs.readdirSync(binDir).length === 0) {
        fs.rmdirSync(binDir);
        lines.push(`folder removed: ${binDir}`);
      }
    } catch {
      /* folder does not exist */
    }
    if (deps.platform === 'win32') {
      const current = readUserPath(deps.ps);
      if (!hasInPathList(current, binDir)) lines.push(`${binDir} was not in the user PATH.`);
      else {
        writeUserPath(deps.ps, removeFromPathList(current, binDir));
        lines.push(`${binDir} removed from the user PATH.`);
      }
      lines.push('Open a new terminal for the updated PATH to take effect.');
    }
    return { code: 0, lines };
  } catch (e) {
    lines.push(`error: ${e instanceof Error ? e.message : String(e)}`);
    return { code: 1, lines };
  }
}
