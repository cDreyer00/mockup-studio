import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  electronEnv,
  locateElectron,
  parseInstallLocation,
  parseRegKeys,
  registryInstallDirs,
} from './electron.js';

const KEY = String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\{abc}`;
const KEYS = ['', KEY, '    DisplayName    REG_SZ    Mockup Studio 0.1.0', ''].join('\r\n');
const VALUE = [
  '',
  KEY,
  String.raw`    InstallLocation    REG_SZ    D:\My Apps\Mockup Studio`,
  '',
].join('\r\n');

describe('custom install folder', () => {
  it('reads the keys and the InstallLocation from the reg query output', () => {
    expect(parseRegKeys(KEYS)).toEqual([KEY]);
    expect(parseInstallLocation(VALUE)).toBe(String.raw`D:\My Apps\Mockup Studio`);
    expect(parseInstallLocation('nothing')).toBeNull();
  });

  it('registryInstallDirs queries HKCU and HKLM and merges the results without repeats', () => {
    const run = (args: string[]): string => {
      if (args.includes('/f')) return args[1]!.startsWith('HKCU') ? KEYS : '';
      return VALUE;
    };
    expect(registryInstallDirs(run)).toEqual([String.raw`D:\My Apps\Mockup Studio`]);
  });

  it.skipIf(process.platform !== 'win32')(
    'locateElectron uses the registry folder before the default path',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-install-'));
      const exe = path.join(dir, 'Mockup Studio.exe');
      fs.writeFileSync(exe, '');
      try {
        const found = locateElectron({ LOCALAPPDATA: String.raw`X:\does-not-exist` }, () => [
          path.join(dir, 'other'),
          dir,
        ]);
        expect(found).toEqual({ exe, args: [], source: 'installed' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('electronEnv', () => {
  it('remove ELECTRON_RUN_AS_NODE', () => {
    const env = electronEnv({ ELECTRON_RUN_AS_NODE: '1', OTHER: 'x' });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.OTHER).toBe('x');
  });

  it('only forwards MOCKUP_DATA_DIR if the user set it (same lock as the open app)', () => {
    expect('MOCKUP_DATA_DIR' in electronEnv({ PATH: 'p' })).toBe(false);
    expect(electronEnv({ MOCKUP_DATA_DIR: 'data' }).MOCKUP_DATA_DIR).toBe('data');
  });
});
