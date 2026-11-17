/**
 * Swapping the headless Node daemon (no render) for Electron: Electron is simulated by an in-process
 * daemon with a fake render engine; the real test with Electron lives in electron.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, serializeDocument } from '@mockup/core';
import {
  checkHealth,
  startDaemon,
  takeOverDaemon,
  type DaemonHandle,
  type RenderProvider,
} from '@mockup/server';
import { ensureDaemon, type EnsureDeps } from './discover.js';

const fakeRender: RenderProvider = {
  capture: () => Promise.reject(new Error('unused')),
  measure: () => Promise.reject(new Error('unused')),
};
const launch = { exe: 'fake', args: [], source: 'MOCKUP_DESKTOP_EXE' as const };

describe('ensureDaemon with a daemon without render', () => {
  let dir: string;
  let file: string;
  let handles: DaemonHandle[];
  const prev = { dir: process.env.MOCKUP_DATA_DIR, port: process.env.MOCKUP_PORT };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-discover-'));
    file = path.join(dir, 'a.mockup.json');
    fs.writeFileSync(file, serializeDocument(createDocument('A')), 'utf8');
    handles = [];
    process.env.MOCKUP_DATA_DIR = path.join(dir, 'data');
  });

  afterEach(async () => {
    await Promise.all(handles.map((h) => h.close()));
    for (const [k, v] of [
      ['MOCKUP_DATA_DIR', prev.dir],
      ['MOCKUP_PORT', prev.port],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startNode(mode: 'headless' | 'serve', canShutdown = true): Promise<DaemonHandle> {
    const h = await startDaemon({
      port: 0,
      dataDir: process.env.MOCKUP_DATA_DIR,
      writeInfo: true,
      mode,
      openFiles: [file],
      onShutdown: canShutdown ? () => undefined : undefined,
    });
    handles.push(h);
    process.env.MOCKUP_PORT = String(h.port);
    return h;
  }

  function deps(
    over: Partial<EnsureDeps> = {},
  ): EnsureDeps & { electron: ReturnType<typeof vi.fn> } {
    const electron = vi.fn(async (_l: unknown, port: number, _t?: number, files: string[] = []) => {
      const h = await startDaemon({
        port,
        dataDir: process.env.MOCKUP_DATA_DIR,
        writeInfo: true,
        render: fakeRender,
        openFiles: files,
      });
      handles.push(h);
      return { pid: process.pid };
    });
    return {
      locate: () => launch,
      spawnElectron: electron as unknown as EnsureDeps['spawnElectron'],
      spawnNode: vi.fn() as unknown as EnsureDeps['spawnNode'],
      takeOver: takeOverDaemon,
      electron,
      ...over,
    };
  }

  it('swaps the headless Node daemon for one with render and the documents stay open', async () => {
    const node = await startNode('headless');
    const d = deps();
    const loc = await ensureDaemon(d);
    expect(d.electron).toHaveBeenCalledTimes(1);
    expect(d.electron.mock.calls[0]![3]).toEqual([file]);
    expect(loc.port).toBe(node.port);
    const health = await checkHealth(loc.url);
    expect(health?.render).toBe(true);
    expect(health?.mode).toBe('desktop');
    const docs = (await (await fetch(`${loc.url}/api/docs`)).json()) as {
      documents: { path: string }[];
    };
    expect(docs.documents.map((x) => path.resolve(x.path))).toEqual([path.resolve(file)]);
  });

  it('does not stop a user `mockup serve`', async () => {
    const node = await startNode('serve');
    const d = deps();
    const loc = await ensureDaemon(d);
    expect(d.electron).not.toHaveBeenCalled();
    expect(loc.port).toBe(node.port);
    expect((await checkHealth(node.url))?.render).toBe(false);
  });

  it('a daemon that refuses shutdown is kept', async () => {
    const node = await startNode('headless', false);
    const d = deps({ takeOver: (url) => takeOverDaemon(url, 500) });
    const loc = await ensureDaemon(d);
    expect(d.electron).not.toHaveBeenCalled();
    expect(loc.port).toBe(node.port);
    expect(await checkHealth(node.url)).not.toBeNull();
  });

  it('without Electron available, keeps the Node daemon', async () => {
    const node = await startNode('headless');
    const d = deps({ locate: () => null });
    const loc = await ensureDaemon(d);
    expect(d.electron).not.toHaveBeenCalled();
    expect(loc.port).toBe(node.port);
    expect(await checkHealth(node.url)).not.toBeNull();
  });

  it('if Electron fails to start, falls back to a Node daemon with the documents', async () => {
    const node = await startNode('headless');
    const spawnNode = vi.fn(async (port?: number, _t?: number, files: string[] = []) => {
      const h = await startDaemon({
        port,
        dataDir: process.env.MOCKUP_DATA_DIR,
        writeInfo: true,
        mode: 'headless',
        openFiles: files,
      });
      handles.push(h);
      return { url: h.url, mcpUrl: h.mcpUrl, wsUrl: h.wsUrl, port: h.port, spawned: true };
    });
    const d = deps({
      spawnElectron: (() => Promise.reject(new Error('failed'))) as EnsureDeps['spawnElectron'],
      spawnNode: spawnNode as unknown as EnsureDeps['spawnNode'],
    });
    const loc = await ensureDaemon(d);
    expect(spawnNode).toHaveBeenCalledWith(node.port, 20000, [file]);
    expect(loc.port).toBe(node.port);
  });
});

describe('resolveDaemonBin / daemonEnv', () => {
  const norm = (s: string) => s.replaceAll(String.fromCharCode(92), '/');
  const present = ['/env/d.mjs', '/b/daemon.mjs', '/s/bin.js'];
  const exists = (p: string) => present.includes(norm(p));
  it('MOCKUP_DAEMON_BIN, then daemon.mjs next to it, then @mockup/server', async () => {
    const { resolveDaemonBin } = await import('./discover.js');
    const env = { MOCKUP_DAEMON_BIN: '/env/d.mjs' };
    expect(resolveDaemonBin({ env, exists, bundleDir: '/b' })).toBe('/env/d.mjs');
    expect(norm(resolveDaemonBin({ env: {}, exists, bundleDir: '/b' }))).toBe('/b/daemon.mjs');
    const viaServer = resolveDaemonBin({
      env: {},
      exists,
      bundleDir: '/x',
      resolveServer: () => '/s/index.js',
    });
    expect(norm(viaServer)).toBe('/s/bin.js');
  });
  it('clear error when nothing is found', async () => {
    const { resolveDaemonBin } = await import('./discover.js');
    expect(() =>
      resolveDaemonBin({
        env: {},
        exists: () => false,
        bundleDir: '/x',
        resolveServer: () => {
          throw new Error('nope');
        },
      }),
    ).toThrow(/MOCKUP_DAEMON_BIN/);
  });
  it('ELECTRON_RUN_AS_NODE only under Electron', async () => {
    const { daemonEnv } = await import('./discover.js');
    expect(daemonEnv('/d', {}, true)).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      MOCKUP_DATA_DIR: '/d',
    });
    expect(daemonEnv('/d', {}, false).ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
