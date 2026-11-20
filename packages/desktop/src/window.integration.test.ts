/**
 * REAL integration: a windowless instance (as started by `mockup mcp`) must show a visible window
 * when the app is launched again (second instance). Covers the current `--mockup-headless` flag and
 * the legacy `--headless`, which is also Chromium's own headless switch (it used to leave every window
 * invisible). Visibility is checked at the OS level (Windows `MainWindowHandle`, which only counts
 * visible top-level windows), so the test runs on Windows only.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort, waitHealth } from './integration-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const electronExe = createRequire(import.meta.url)('electron') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

interface OsWindow {
  handle: number;
  title: string;
}

/** Visible main window of the process, as Windows reports it (handle 0 = none). */
function mainWindow(pid: number): OsWindow {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; "$([int64]$p.MainWindowHandle)|$($p.MainWindowTitle)"`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 },
  );
  const [handle = '0', ...title] = r.stdout.trim().split('|');
  return { handle: Number(handle), title: title.join('|') };
}

async function waitWindow(pid: number, ms = 45000): Promise<OsWindow> {
  const end = Date.now() + ms;
  let w = mainWindow(pid);
  while (Date.now() < end && !w.handle) {
    await new Promise((r) => setTimeout(r, 500));
    w = mainWindow(pid);
  }
  return w;
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

describe.skipIf(!built || !editorReady || process.platform !== 'win32')(
  'Second launch shows a window over a windowless instance',
  () => {
    const children: ChildProcess[] = [];
    let tmp = '';

    afterEach(async () => {
      await Promise.all(
        children.splice(0).map(async (c) => {
          if (c.exitCode !== null || c.signalCode !== null) return;
          const exited = new Promise((r) => c.once('exit', r));
          killTree(c);
          await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
        }),
      );
      // Chromium's child processes may hold userData for a moment after the main one exits
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    });

    function launch(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
      const c = spawn(electronExe, [appDir, ...args], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      children.push(c);
      return c;
    }

    it.each(['--mockup-headless', '--headless'])(
      'started with %s, a second launch opens a visible window in the same instance',
      async (flag) => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-window-'));
        // own userData: the single-instance lock never reaches another Mockup Studio on this machine
        const dataDir = path.join(tmp, 'data');
        fs.mkdirSync(dataDir);
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        const env: NodeJS.ProcessEnv = { ...process.env, MOCKUP_DATA_DIR: dataDir };
        delete env.ELECTRON_RUN_AS_NODE;

        const first = launch([flag, '--port', String(port), '--data-dir', dataDir], env);
        let stderr = '';
        first.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
        await waitHealth(url, first);
        expect(mainWindow(first.pid!).handle, 'windowless instance has a visible window').toBe(0);

        const second = launch(['--data-dir', dataDir], env);
        const code = await new Promise<number | null>((r) => second.once('exit', r));
        expect(code, 'second instance hands over and exits').toBe(0);

        const w = await waitWindow(first.pid!);
        expect(w.handle, stderr).not.toBe(0);
        expect(w.title).toMatch(/Mockup Studio/);
        // still the same daemon: MCP sessions of the windowless instance keep working
        const h = (await (await fetch(`${url}/api/health`)).json()) as { pid: number };
        expect(h.pid).toBe(first.pid);
      },
    );
  },
);
