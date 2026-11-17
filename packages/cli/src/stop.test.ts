import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHealth, startDaemon, type DaemonHandle } from '@mockup/server';
import { stop } from './commands.js';

describe('mockup stop', () => {
  let dir: string;
  let handle: DaemonHandle | undefined;
  const prev = { dir: process.env.MOCKUP_DATA_DIR, port: process.env.MOCKUP_PORT };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-stop-'));
    process.env.MOCKUP_DATA_DIR = dir;
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    for (const [k, v] of [
      ['MOCKUP_DATA_DIR', prev.dir],
      ['MOCKUP_PORT', prev.port],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(onShutdown?: () => void): Promise<DaemonHandle> {
    handle = await startDaemon({ port: 0, dataDir: dir, writeInfo: true, onShutdown });
    process.env.MOCKUP_PORT = String(handle.port);
    return handle;
  }

  it('stops a daemon that allows it', async () => {
    const h = await start(() => undefined);
    await stop();
    expect(await checkHealth(h.url, 300)).toBeNull();
  });

  it('the desktop app with a window (without onShutdown) refuses with a clear message', async () => {
    const h = await start();
    await expect(stop()).rejects.toThrow(/window/);
    expect(await checkHealth(h.url)).not.toBeNull();
  });

  it('does not fail without a daemon', async () => {
    process.env.MOCKUP_PORT = '1';
    await expect(stop()).resolves.toBeUndefined();
  });
});
