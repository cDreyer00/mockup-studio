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
  String.raw`    InstallLocation    REG_SZ    D:\Meus Apps\Mockup Studio`,
  '',
].join('\r\n');

describe('pasta de instalação personalizada', () => {
  it('lê as chaves e o InstallLocation da saída do reg query', () => {
    expect(parseRegKeys(KEYS)).toEqual([KEY]);
    expect(parseInstallLocation(VALUE)).toBe(String.raw`D:\Meus Apps\Mockup Studio`);
    expect(parseInstallLocation('nada')).toBeNull();
  });

  it('registryInstallDirs consulta HKCU e HKLM e junta os resultados sem repetir', () => {
    const run = (args: string[]): string => {
      if (args.includes('/f')) return args[1]!.startsWith('HKCU') ? KEYS : '';
      return VALUE;
    };
    expect(registryInstallDirs(run)).toEqual([String.raw`D:\Meus Apps\Mockup Studio`]);
  });

  it.skipIf(process.platform !== 'win32')(
    'locateElectron usa a pasta do registro antes do caminho padrão',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-install-'));
      const exe = path.join(dir, 'Mockup Studio.exe');
      fs.writeFileSync(exe, '');
      try {
        const found = locateElectron({ LOCALAPPDATA: String.raw`X:\nao-existe` }, () => [
          path.join(dir, 'outra'),
          dir,
        ]);
        expect(found).toEqual({ exe, args: [], source: 'instalado' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('electronEnv', () => {
  it('remove ELECTRON_RUN_AS_NODE', () => {
    const env = electronEnv({ ELECTRON_RUN_AS_NODE: '1', OUTRA: 'x' });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.OUTRA).toBe('x');
  });

  it('só repassa MOCKUP_DATA_DIR se o usuário o definiu (mesmo lock do app aberto)', () => {
    expect('MOCKUP_DATA_DIR' in electronEnv({ PATH: 'p' })).toBe(false);
    expect(electronEnv({ MOCKUP_DATA_DIR: 'dados' }).MOCKUP_DATA_DIR).toBe('dados');
  });
});
