import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Home with its own daemon + Vite (other ports, temporary folder): the daemon is killed and
 * restarted while Home is open, which the shared e2e daemon cannot do.
 */
const DAEMON_PORT = 4851;
const EDITOR_PORT = 5351;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.resolve(dirname, '..');
const serverBin = path.resolve(editorDir, '../server/dist/bin.js');

let tmp = '';
let daemon: ChildProcess | null = null;
let vite: ChildProcess | null = null;

async function waitFor(url: string, up: boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await fetch(url)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok === up) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${url} did not become ${up ? 'up' : 'down'}`);
}

async function startDaemon(): Promise<void> {
  if (daemon && daemon.exitCode === null) return;
  daemon = spawn(
    process.execPath,
    [serverBin, '--port', String(DAEMON_PORT), '--data-dir', path.join(tmp, 'data')],
    { stdio: 'ignore' },
  );
  await waitFor(`http://127.0.0.1:${DAEMON_PORT}/api/health`, true);
}

function stopDaemon(): Promise<void> {
  const d = daemon;
  daemon = null;
  if (!d || d.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    d.once('exit', () => resolve());
    d.kill();
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-home-reconnect-'));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  await startDaemon();
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.join(tmp, `doc-${i}.mockup.json`), name: `doc-${i}` }),
    });
    expect(res.ok).toBe(true);
  }
  vite = spawn(
    process.execPath,
    [
      path.resolve(editorDir, '../../node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(EDITOR_PORT),
      '--strictPort',
    ],
    {
      cwd: editorDir,
      env: { ...process.env, VITE_DAEMON_PORT: String(DAEMON_PORT) },
      stdio: 'ignore',
    },
  );
  await waitFor(`http://127.0.0.1:${EDITOR_PORT}`, true, 60_000);
});

test.afterAll(async () => {
  await stopDaemon();
  vite?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('daemon killed while on Home: the list is not blanked; after the restart it reloads', async ({
  page,
}) => {
  await page.goto(`http://127.0.0.1:${EDITOR_PORT}/`);
  await page.getByTestId('home-button').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await page.getByTestId('home-nav-all').click();
  await expect(page.getByTestId('file-card')).toHaveCount(6);

  await stopDaemon();
  await waitFor(`http://127.0.0.1:${DAEMON_PORT}/api/health`, false);

  // the reconnect must trigger a fresh list request (the list is not left as it was)
  const reloads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/files') && !r.url().includes('thumbnail')) reloads.push(r.url());
  });
  await startDaemon();
  await expect.poll(() => reloads.length, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('file-card')).toHaveCount(6);
  await expect(page.getByTestId('home-error')).toHaveCount(0);
});

// With the daemon offline the app hides Home entirely (App.tsx), so a failed list request is
// simulated here by aborting it while the daemon stays up.
test('a list request fails for a view without cache: error with Retry, then the list loads', async ({
  page,
}) => {
  await startDaemon();
  await page.goto(`http://127.0.0.1:${EDITOR_PORT}/`);
  await page.getByTestId('home-button').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await page.getByTestId('home-nav-all').click();
  await expect(page.getByTestId('file-card').first()).toBeVisible();

  const failList = (url: URL) => url.pathname === '/api/files';
  await page.route(failList, (route) => route.abort());
  // Favorites was never loaded: no cache, so the failure must be visible (not an empty screen)
  await page.getByTestId('home-nav-favorites').click();
  await expect(page.getByTestId('home-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('home-retry')).toBeVisible();

  await page.unroute(failList);
  await page.getByTestId('home-retry').click();
  await expect(page.getByTestId('home-empty')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('home-error')).toHaveCount(0);
  await page.getByTestId('home-nav-all').click();
  await expect(page.getByTestId('file-card')).toHaveCount(6);
});
