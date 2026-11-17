import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe.skipIf(!fs.existsSync(bin))('mockup doctor --json (dist)', () => {
  it('relata sem daemon, com porta livre', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-doctor-'));
    const port = await freePort();
    try {
      const r = spawnSync(process.execPath, [bin, 'doctor', '--json'], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, MOCKUP_DATA_DIR: dir, MOCKUP_PORT: String(port) },
      });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      const by = (id: string) => j.checks.find((c: { id: string }) => c.id === id);
      expect(j.ok).toBe(true);
      expect(by('dataDir').detail).toBe(dir);
      expect(by('daemon').level).toBe('warn');
      expect(by('port').label).toBe(`Porta ${port}`);
      expect(by('port').detail).toBe('livre');
      expect(j.commands.claudeStdio).toContain('mockup-studio');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--version e comando desconhecido', () => {
    expect(spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).stdout).toMatch(
      /^\d+\.\d+\.\d+/,
    );
    expect(spawnSync(process.execPath, [bin, 'xyz'], { encoding: 'utf8' }).status).toBe(1);
  });
});
