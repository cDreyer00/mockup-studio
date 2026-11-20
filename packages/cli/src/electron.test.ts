import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth } from '@mockup/server';
import { electronArgs, locateElectron, spawnElectronHeadless } from './electron.js';

const withElectron = { ...process.env, MOCKUP_NO_ELECTRON: undefined } as NodeJS.ProcessEnv;

describe('locateElectron', () => {
  it('MOCKUP_NO_ELECTRON=1 disables Electron', () => {
    expect(locateElectron({ ...process.env, MOCKUP_NO_ELECTRON: '1' })).toBeNull();
  });

  it('MOCKUP_DESKTOP_EXE points to the executable', () => {
    const exe = process.execPath;
    expect(locateElectron({ ...withElectron, MOCKUP_DESKTOP_EXE: exe })).toEqual({
      exe,
      args: [],
      source: 'MOCKUP_DESKTOP_EXE',
    });
  });

  it('electronArgs builds --mockup-headless --port (dev: after the app path)', () => {
    const l = { exe: 'e', args: ['app'], source: 'dev' as const };
    expect(electronArgs(l, 5000)).toEqual(['app', '--mockup-headless', '--port', '5000']);
  });

  it("electronArgs for the packaged app passes the files and never Chromium's --headless", () => {
    const l = { exe: 'Mockup Studio.exe', args: [], source: 'installed' as const };
    const a = electronArgs(l, 4747, ['D:\\a.mockup.json']);
    expect(a).toEqual(['--mockup-headless', '--port', '4747', 'D:\\a.mockup.json']);
    expect(a).not.toContain('--headless');
  });
});

const dev = locateElectron(withElectron);
const editorReady = (): boolean => {
  const l = dev;
  return (
    !!l && l.source === 'dev' && fs.existsSync(path.join(l.args[0]!, '../editor/dist/render.html'))
  );
};

describe.skipIf(!dev || !editorReady())('spawnElectronHeadless (Electron real)', () => {
  let dataDir: string;
  let pid: number | undefined;
  const prev = process.env.MOCKUP_DATA_DIR;

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-cli-electron-'));
    process.env.MOCKUP_DATA_DIR = dataDir;
  });

  let port = 0;

  afterAll(async () => {
    if (pid) {
      try {
        // On Windows `process.kill` only ends the main process; the children (GPU, render) keep
        // holding userData. `taskkill /T` kills the whole tree.
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(pid);
      } catch {
        /* already exited */
      }
      // Wait for the daemon to stop responding: the Electron child processes (GPU, render)
      // still hold userData files for a few moments after the main one.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await checkHealth(`http://127.0.0.1:${port}`, 300))) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (prev === undefined) delete process.env.MOCKUP_DATA_DIR;
    else process.env.MOCKUP_DATA_DIR = prev;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (e) {
      // With other Electron instances running in parallel (desktop test), Windows sometimes keeps the
      // folder locked for a few more seconds; it is only the temp folder, so it does not fail the test.
      console.warn('[test] could not remove', dataDir, (e as Error).message);
    }
  });

  it('starts the headless one and health reports render: true', async () => {
    port = 49000 + Math.floor(Math.random() * 1000);
    ({ pid } = await spawnElectronHeadless(dev!, port));
    const h = await checkHealth(`http://127.0.0.1:${port}`);
    expect(h?.render).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'daemon.json'))).toBe(true);
  });
});

describe('locateElectron embedded', () => {
  const self = {
    versions: { ...process.versions, electron: '40.0.0' },
    execPath: String.raw`C:\App\Mockup Studio.exe`,
  };
  it('under Electron the executable itself is the app', () => {
    expect(locateElectron(withElectron, () => [], self)).toEqual({
      exe: self.execPath,
      args: [],
      source: 'embedded',
    });
  });
  it('MOCKUP_DESKTOP_EXE takes priority and MOCKUP_NO_ELECTRON disables it', () => {
    const env = { ...withElectron, MOCKUP_DESKTOP_EXE: process.execPath };
    expect(locateElectron(env, () => [], self)?.source).toBe('MOCKUP_DESKTOP_EXE');
    expect(locateElectron({ ...withElectron, MOCKUP_NO_ELECTRON: '1' }, () => [], self)).toBeNull();
  });
});
