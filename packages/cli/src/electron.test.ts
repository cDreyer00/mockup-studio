import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth } from '@mockup/server';
import { electronArgs, electronEnv, locateElectron, spawnElectronHeadless } from './electron.js';

const withElectron = { ...process.env, MOCKUP_NO_ELECTRON: undefined } as NodeJS.ProcessEnv;

describe('locateElectron', () => {
  it('MOCKUP_NO_ELECTRON=1 desliga o Electron', () => {
    expect(locateElectron({ ...process.env, MOCKUP_NO_ELECTRON: '1' })).toBeNull();
  });

  it('MOCKUP_DESKTOP_EXE aponta para o executável', () => {
    const exe = process.execPath;
    expect(locateElectron({ ...withElectron, MOCKUP_DESKTOP_EXE: exe })).toEqual({
      exe,
      args: [],
      source: 'MOCKUP_DESKTOP_EXE',
    });
  });

  it('electronEnv remove ELECTRON_RUN_AS_NODE e fixa a pasta de dados', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const env = electronEnv('X:\\dados');
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.MOCKUP_DATA_DIR).toBe('X:\\dados');
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });

  it('electronArgs monta --headless --port', () => {
    const l = { exe: 'e', args: ['app'], source: 'dev' as const };
    expect(electronArgs(l, 5000)).toEqual(['app', '--headless', '--port', '5000']);
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
        // No Windows `process.kill` encerra só o principal; os filhos (GPU, render) ficam
        // segurando o userData. `taskkill /T` derruba a árvore inteira.
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(pid);
      } catch {
        /* já encerrou */
      }
      // Espera o daemon parar de responder: os processos filhos do Electron (GPU, render)
      // ainda seguram arquivos do userData por alguns instantes depois do principal.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await checkHealth(`http://127.0.0.1:${port}`, 300))) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (prev === undefined) delete process.env.MOCKUP_DATA_DIR;
    else process.env.MOCKUP_DATA_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('sobe o headless e o health informa render: true', async () => {
    port = 49000 + Math.floor(Math.random() * 1000);
    ({ pid } = await spawnElectronHeadless(dev!, port));
    const h = await checkHealth(`http://127.0.0.1:${port}`);
    expect(h?.render).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'daemon.json'))).toBe(true);
  });
});
