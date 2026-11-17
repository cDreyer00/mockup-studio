import { describe, expect, it } from 'vitest';
import { parseArgs, userArgs } from './main/args.js';

describe('parseArgs', () => {
  it('interpreta headless, porta, data-dir e arquivos', () => {
    expect(
      parseArgs(['--headless', '--port', '5000', '--data-dir', 'D:\\dados', 'a.mockup.json']),
    ).toEqual({
      headless: true,
      cliArgs: [],
      port: 5000,
      dataDir: 'D:\\dados',
      files: ['a.mockup.json'],
    });
  });

  it('aceita --port=N e ignora opções do Chromium', () => {
    const a = parseArgs(['--port=0', '--no-sandbox', '--inspect=9229', 'x.json', 'y.txt']);
    expect(a.port).toBe(0);
    expect(a.headless).toBe(false);
    expect(a.files).toEqual(['x.json']);
  });

  it('rejeita porta inválida', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/--port/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(/--port/);
    expect(() => parseArgs(['--data-dir'])).toThrow(/--data-dir/);
  });

  it('--install-cli e --uninstall-cli repassam os demais argumentos ao CLI', () => {
    const a = parseArgs(['--install-cli', '--bin-dir', 'D:\\bin', '--quiet']);
    expect(a.cliAction).toBe('install-cli');
    expect(a.cliArgs).toEqual(['--bin-dir', 'D:\\bin', '--quiet']);
    const b = parseArgs(['--quiet', '--uninstall-cli']);
    expect(b.cliAction).toBe('uninstall-cli');
    expect(b.cliArgs).toEqual(['--quiet']);
    expect(parseArgs(['x.json']).cliAction).toBeUndefined();
  });

  it('userArgs corta o executável e, em dev, o caminho do app', () => {
    expect(userArgs(['exe', 'a'], false)).toEqual(['a']);
    expect(userArgs(['electron', '.', 'a'], true)).toEqual(['a']);
  });
});
