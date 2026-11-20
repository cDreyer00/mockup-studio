import { describe, expect, it } from 'vitest';
import { parseArgs, userArgs } from './main/args.js';

describe('parseArgs', () => {
  it('parses headless, port, data-dir and files', () => {
    expect(
      parseArgs(['--mockup-headless', '--port', '5000', '--data-dir', 'D:\\data', 'a.mockup.json']),
    ).toEqual({
      headless: true,
      cliArgs: [],
      port: 5000,
      dataDir: 'D:\\data',
      files: ['a.mockup.json'],
    });
  });

  it('accepts --port=N and ignores Chromium options', () => {
    const a = parseArgs(['--port=0', '--no-sandbox', '--inspect=9229', 'x.json', 'y.txt']);
    expect(a.port).toBe(0);
    expect(a.headless).toBe(false);
    expect(a.files).toEqual(['x.json']);
  });

  it('still accepts the legacy --headless flag and marks it', () => {
    const a = parseArgs(['--headless', '--port', '4747']);
    expect(a.headless).toBe(true);
    expect(a.legacyHeadless).toBe(true);
    expect(parseArgs(['--mockup-headless']).legacyHeadless).toBeUndefined();
    expect(parseArgs(['x.json']).legacyHeadless).toBeUndefined();
  });

  it('only the exact flags turn on windowless mode', () => {
    expect(parseArgs(['--headless=new']).headless).toBe(false);
    expect(parseArgs(['--mockup-headless=1']).headless).toBe(false);
    expect(parseArgs([]).headless).toBe(false);
  });

  it('rejects an invalid port', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/--port/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(/--port/);
    expect(() => parseArgs(['--data-dir'])).toThrow(/--data-dir/);
  });

  it('--install-cli and --uninstall-cli pass the remaining arguments to the CLI', () => {
    const a = parseArgs(['--install-cli', '--bin-dir', 'D:\\bin', '--quiet']);
    expect(a.cliAction).toBe('install-cli');
    expect(a.cliArgs).toEqual(['--bin-dir', 'D:\\bin', '--quiet']);
    const b = parseArgs(['--quiet', '--uninstall-cli']);
    expect(b.cliAction).toBe('uninstall-cli');
    expect(b.cliArgs).toEqual(['--quiet']);
    expect(parseArgs(['x.json']).cliAction).toBeUndefined();
  });

  it('userArgs strips the executable and, in dev, the app path', () => {
    expect(userArgs(['exe', 'a'], false)).toEqual(['a']);
    expect(userArgs(['electron', '.', 'a'], true)).toEqual(['a']);
  });
});
