import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliRuntime } from './runtime.js';
import { VERSION } from './version.js';

describe('cliRuntime', () => {
  it('Node', () => {
    const r = cliRuntime({ argv1: 'x.js', realpath: (p) => `/real/${p}`, execPath: 'node' });
    expect(r).toMatchObject({ kind: 'node', script: '/real/x.js', execPath: 'node' });
  });
  it('Electron', () => {
    const r = cliRuntime({
      versions: { ...process.versions, electron: '40.0.0' },
      argv1: 'mockup.mjs',
      realpath: (p) => p,
    });
    expect(r).toMatchObject({ kind: 'electron', electronVersion: '40.0.0' });
  });
  it('VERSION bate com o package.json', () => {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    expect(JSON.parse(fs.readFileSync(pkg, 'utf8')).version).toBe(VERSION);
  });
});
