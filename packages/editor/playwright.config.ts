import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Editor E2E: starts a daemon on a test port with a temporary data folder, and Vite
 * pointing at it. The folder is created once by the main process and inherited by the workers
 * via an environment variable.
 */
const dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PORT = Number(process.env.MOCKUP_E2E_DAEMON_PORT ?? 4848);
const EDITOR_PORT = Number(process.env.MOCKUP_E2E_EDITOR_PORT ?? 5273);

process.env.MOCKUP_E2E_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-e2e-'));
process.env.MOCKUP_E2E_DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;
const dataDir = path.join(process.env.MOCKUP_E2E_DIR, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export default defineConfig({
  testDir: './e2e',
  // A single shared active daemon/document: tests run serially.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${EDITOR_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /screenshot\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // `npm run screenshot`: generates docs/img/editor.png for the README.
      name: 'screenshot',
      testMatch: /screenshot\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 960 } },
    },
  ],
  webServer: [
    {
      command: `node ../server/dist/bin.js --port ${DAEMON_PORT} --data-dir "${dataDir}"`,
      cwd: dirname,
      url: `http://127.0.0.1:${DAEMON_PORT}/api/health`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 30_000,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${EDITOR_PORT} --strictPort`,
      cwd: dirname,
      url: `http://127.0.0.1:${EDITOR_PORT}`,
      env: { VITE_DAEMON_PORT: String(DAEMON_PORT) },
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 60_000,
    },
  ],
});
