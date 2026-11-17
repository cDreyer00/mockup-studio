import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  READ_PATH_SCRIPT,
  SHIM_MARKER,
  addToPathList,
  buildShim,
  installCli,
  removeFromPathList,
  uninstallCli,
  type InstallDeps,
  type PsRunner,
} from './install.js';
import type { CliRuntime } from './runtime.js';

describe('PATH list', () => {
  it('adds without duplicating (case and trailing slash)', () => {
    expect(addToPathList('C:\\a;%USERPROFILE%\\b', 'C:\\x')).toBe('C:\\a;%USERPROFILE%\\b;C:\\x');
    expect(addToPathList('C:\\a;C:\\X\\', 'c:\\x')).toBe('C:\\a;C:\\X\\');
    expect(addToPathList('', 'C:\\x')).toBe('C:\\x');
    expect(addToPathList('C:\\a;;', 'C:\\x')).toBe('C:\\a;C:\\x');
  });
  it('removes keeping the order and without ;;', () => {
    expect(removeFromPathList('C:\\a;C:\\X\\;%V%\\b;c:\\x', 'C:\\x')).toBe('C:\\a;%V%\\b');
    expect(removeFromPathList('C:\\x', 'C:\\x')).toBe('');
  });
});

const rtNode: CliRuntime = {
  kind: 'node',
  execPath: 'C:\\Program Files\\nodejs\\node.exe',
  script: 'C:\\cli\\bin.js',
  version: '0.1.0',
  nodeVersion: '24.0.0',
};

describe('buildShim', () => {
  it('Node', () => {
    expect(buildShim(rtNode, 'win32')).toBe(
      `@echo off\r\nrem ${SHIM_MARKER}\r\nsetlocal\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\cli\\bin.js" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    );
  });
  it('Electron define ELECTRON_RUN_AS_NODE', () => {
    const s = buildShim({ ...rtNode, kind: 'electron' }, 'win32');
    expect(s).toContain('set ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files');
  });
});

describe('install-cli / uninstall-cli', () => {
  let tmp: string;
  let calls: { script: string; env: Record<string, string> }[];
  let userPath: string;
  let fail = false;
  const ps: PsRunner = (script, env) => {
    calls.push({ script, env });
    if (fail) return { status: 1, stdout: '', stderr: 'boom' };
    if (script === READ_PATH_SCRIPT) return { status: 0, stdout: userPath + '\r\n', stderr: '' };
    userPath = env.MOCKUP_NEW_PATH;
    return { status: 0, stdout: '', stderr: '' };
  };
  const deps = (): InstallDeps => ({
    runtime: rtNode,
    platform: 'win32',
    env: {},
    home: tmp,
    ps,
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-install-'));
    calls = [];
    userPath = 'C:\\a;%USERPROFILE%\\b';
    fail = false;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('installs the shim, updates the PATH and is idempotent', () => {
    const bin = path.join(tmp, 'bin');
    const r = installCli({ binDir: bin }, deps());
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(bin, 'mockup.cmd'), 'utf8')).toBe(buildShim(rtNode, 'win32'));
    expect(userPath).toBe(`C:\\a;%USERPROFILE%\\b;${bin}`);
    const write = calls.find((c) => c.env.MOCKUP_NEW_PATH);
    expect(write?.script).toContain('ExpandString');
    expect(write?.script).toContain('MOCKUP_STUDIO_PATH_REFRESH');
    expect(write?.script).not.toContain(bin);

    calls = [];
    const again = installCli({ binDir: bin }, deps());
    expect(again.code).toBe(0);
    expect(again.lines.join('\n')).toContain('updated');
    expect(calls.filter((c) => c.env.MOCKUP_NEW_PATH)).toHaveLength(0);
  });

  it('PATH with a stray ; and the folder already present: does not write and says it is already there', () => {
    const bin = path.join(tmp, 'bin');
    userPath = `C:\\a;${bin};`;
    const r = installCli({ binDir: bin }, deps());
    expect(r.lines.join('\n')).toContain('already in');
    expect(r.lines.join('\n')).not.toContain('added');
    expect(calls.filter((c) => c.env.MOCKUP_NEW_PATH)).toHaveLength(0);

    const u = uninstallCli({ binDir: bin }, deps());
    expect(u.lines.join('\n')).toContain('removed from the user PATH');
    expect(userPath).toBe('C:\\a');
    calls = [];
    userPath = 'C:\\a;;';
    const again = uninstallCli({ binDir: bin }, deps());
    expect(again.lines.join('\n')).toContain('was not in');
    expect(calls.filter((c) => c.env.MOCKUP_NEW_PATH)).toHaveLength(0);
  });

  it('refuses to overwrite a mockup.cmd that is not ours', () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'mockup.cmd'), '@echo other');
    expect(installCli({ binDir: bin }, deps()).code).toBe(1);
    expect(fs.readFileSync(path.join(bin, 'mockup.cmd'), 'utf8')).toBe('@echo other');
  });

  it('refuses to install from the portable executable', () => {
    const bin = path.join(tmp, 'bin');
    const env = { PORTABLE_EXECUTABLE_DIR: 'C:\\Downloads' };
    const r = installCli({ binDir: bin }, { ...deps(), env });
    expect(r.code).toBe(1);
    expect(r.lines.join(' ')).toContain('portable');
    expect(fs.existsSync(bin)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('PowerShell failure returns code 1', () => {
    fail = true;
    expect(installCli({ binDir: path.join(tmp, 'bin') }, deps()).code).toBe(1);
  });

  it('uninstalls: removes shim, empty folder and PATH entry', () => {
    const bin = path.join(tmp, 'bin');
    installCli({ binDir: bin }, deps());
    const r = uninstallCli({ binDir: bin }, deps());
    expect(r.code).toBe(0);
    expect(fs.existsSync(bin)).toBe(false);
    expect(userPath).toBe('C:\\a;%USERPROFILE%\\b');
  });

  it('uninstalls without touching a foreign file', () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'mockup.cmd'), '@echo other');
    uninstallCli({ binDir: bin }, deps());
    expect(fs.existsSync(path.join(bin, 'mockup.cmd'))).toBe(true);
  });
});
