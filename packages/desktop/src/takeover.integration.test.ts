/**
 * REAL integration: a Node daemon without render occupies the port; headless Electron asks it to shut down,
 * takes over the port (with render) and reopens the documents; `POST /api/shutdown` quits the headless app.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, serializeDocument } from '@mockup/core';
import { checkHealth, startDaemon, type DaemonHandle } from '@mockup/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const electronExe = createRequire(import.meta.url)('electron') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

describe.skipIf(!built || !editorReady)(
  'Electron takes over the port of a Node daemon without render',
  () => {
    let tmp: string;
    let node: DaemonHandle;
    let child: ChildProcess;
    let url: string;
    let file: string;
    let stderr = '';

    beforeAll(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-takeover-'));
      const dataDir = path.join(tmp, 'data');
      fs.mkdirSync(dataDir);
      file = path.join(tmp, 'a.mockup.json');
      fs.writeFileSync(file, serializeDocument(createDocument('A')), 'utf8');
      const port = await freePort();
      url = `http://127.0.0.1:${port}`;
      node = await startDaemon({
        port,
        dataDir,
        writeInfo: false,
        headless: true,
        openFiles: [file],
        onShutdown: () => undefined,
      });
      const env: NodeJS.ProcessEnv = { ...process.env, MOCKUP_DATA_DIR: dataDir };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(
        electronExe,
        [appDir, '--mockup-headless', '--port', String(port), '--data-dir', dataDir],
        { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      );
      child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    });

    afterAll(async () => {
      await node?.close();
      if (child) {
        const exited = new Promise((r) => child.once('exit', r));
        killTree(child);
        await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
      }
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    });

    it('switches to the Electron daemon (render, desktop mode) with the document reopened', async () => {
      const end = Date.now() + 60000;
      let h = await checkHealth(url, 500);
      while (Date.now() < end && !(h?.render === true)) {
        if (child.exitCode !== null)
          throw new Error(`Electron exited (${child.exitCode}): ${stderr}`);
        await new Promise((r) => setTimeout(r, 250));
        h = await checkHealth(url, 500);
      }
      expect(h?.render, stderr).toBe(true);
      expect(h?.mode).toBe('desktop');
      expect(h?.canShutdown).toBe(true);
      const docs = (await (await fetch(`${url}/api/docs`)).json()) as {
        documents: { path: string }[];
      };
      expect(docs.documents.map((d) => path.resolve(d.path))).toEqual([path.resolve(file)]);
    });

    it('POST /api/shutdown quits the headless app', async () => {
      const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
      const res = await fetch(`${url}/api/shutdown`, { method: 'POST' });
      expect(res.status).toBe(202);
      const code = await Promise.race([
        exited,
        new Promise<string>((r) => setTimeout(() => r('timeout'), 20000)),
      ]);
      expect(code, stderr).not.toBe('timeout');
      expect(await checkHealth(url, 300)).toBeNull();
    });
  },
);
