import { describe, expect, it } from 'vitest';
import { tomlString } from './launch.js';
import {
  findSection,
  parseDoc,
  readServerTable,
  removeKeyOrTable,
  renderDoc,
  scanValue,
  setEnv,
  setKey,
  tomlError,
} from './tomlEdit.js';

const doc = (...lines: string[]) => parseDoc(lines.join('\n'));
const keys = (d: ReturnType<typeof parseDoc>, sub?: string) =>
  findSection(d, sub)?.entries.map((e) => `${e.key}@${e.from}-${e.to}`);

describe('scanValue', () => {
  it('end-of-line comment, outside a string', () => {
    expect(scanValue(' "a#b" # c')).toEqual({ complete: true, comment: '# c' });
    expect(scanValue(" 'x' ")).toEqual({ complete: true, comment: undefined });
  });
  it('array with a comment inside continues until closed', () => {
    expect(scanValue(' [ # c ]').complete).toBe(false);
    expect(scanValue(' [ # c ]\n "a",\n] # end')).toEqual({ complete: true, comment: '# end' });
  });
  it('multi-line string', () => {
    expect(scanValue(' """abc').complete).toBe(false);
    expect(scanValue(' """abc\n[x] = 1\n"""').complete).toBe(true);
    expect(scanValue(" '''a\\'''").complete).toBe(true);
    expect(scanValue(' """a\\"""\n"""').complete).toBe(true);
  });
});

describe('findSection', () => {
  it('multi-line array with a comment inside', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'args = [ # list', '  "a", # one', ']', 'x = 1');
    expect(keys(d)).toEqual(['args@1-4', 'x@4-5']);
  });
  it('""" string with a line that looks like a header or key', () => {
    const d = doc(
      '[mcp_servers.mockup-studio]',
      'command = """',
      '[fake]',
      'url = "no"',
      '"""',
      'args = []',
      '[mcp_servers.other]',
    );
    expect(keys(d)).toEqual(['command@1-5', 'args@5-6']);
    expect(findSection(d)?.end).toBe(6);
  });
  it('env subtable with a quoted header', () => {
    const d = doc('[mcp_servers."mockup-studio".env] # c', 'A = "1"');
    expect(keys(d, 'env')).toEqual(['A@1-2']);
  });
});

describe('setKey', () => {
  it('preserves the end-of-line comment and is idempotent', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'command = "old" # my comment', '');
    expect(setKey(d, 'command', '"new"')).toBe(true);
    expect(d.lines[1]).toBe('command = "new" # my comment');
    expect(setKey(d, 'command', '"new"')).toBe(false);
  });
  it('replaces a multi-line array with one line, keeping the final comment', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'args = [ # x', '  "a",', '] # end', 'y = 2');
    setKey(d, 'args', '["mcp"]');
    expect(renderDoc(d)).toBe('[mcp_servers.mockup-studio]\nargs = ["mcp"] # end\ny = 2');
  });
  it('replaces a whole """ string', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'command = """', 'a', '"""', 'z = 1');
    setKey(d, 'command', '"b"');
    expect(renderDoc(d)).toBe('[mcp_servers.mockup-studio]\ncommand = "b"\nz = 1');
  });
});

describe('removeKeyOrTable', () => {
  it('removes the inline key and the subtable, keeping the other sections and the final break', () => {
    const d = doc(
      '[mcp_servers.mockup-studio]',
      'command = "x"',
      'env = { A = "1" }',
      '',
      '[mcp_servers.mockup-studio.env]',
      'B = "2"',
      '',
      '[mcp_servers.other]',
      'command = "o"',
      '',
    );
    expect(removeKeyOrTable(d, 'env')).toEqual(['env', '[mcp_servers.mockup-studio.env]']);
    expect(renderDoc(d)).toBe(
      '[mcp_servers.mockup-studio]\ncommand = "x"\n\n[mcp_servers.other]\ncommand = "o"\n',
    );
  });
  it('subtable at the end of the file', () => {
    const d = doc(
      '[mcp_servers.mockup-studio]',
      'url = "u"',
      '',
      '[mcp_servers.mockup-studio.env]',
      'A = "1"',
      '',
    );
    removeKeyOrTable(d, 'env');
    expect(renderDoc(d)).toBe('[mcp_servers.mockup-studio]\nurl = "u"\n');
  });
});

describe('setEnv', () => {
  it('inline env: rewrites inline, without creating a subtable', () => {
    const d = doc(
      '[mcp_servers.mockup-studio]',
      'command = "x"',
      'env = { FOO = "bar" } # vars',
      '',
    );
    expect(setEnv(d, { ELECTRON_RUN_AS_NODE: '1' }, tomlString)).toBe(true);
    const text = renderDoc(d);
    expect(text).toBe(
      '[mcp_servers.mockup-studio]\ncommand = "x"\nenv = { FOO = "bar", ELECTRON_RUN_AS_NODE = "1" } # vars\n',
    );
    expect(tomlError(text)).toBeNull();
    expect(setEnv(d, { ELECTRON_RUN_AS_NODE: '1' }, tomlString)).toBe(false);
  });
  it('without env: creates the subtable after the section', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'command = "x"', '', '[other]', '');
    setEnv(d, { A: '1' }, tomlString);
    expect(renderDoc(d)).toBe(
      '[mcp_servers.mockup-studio]\ncommand = "x"\n\n[mcp_servers.mockup-studio.env]\nA = "1"\n\n[other]\n',
    );
  });
  it('env with a dotted key: throws; the new subtable goes to the end of the section', () => {
    expect(() =>
      setEnv(doc('[mcp_servers.mockup-studio]', 'env.A = "1"'), { B: '2' }, tomlString),
    ).toThrow(/dotted keys/);
    const d = doc('[mcp_servers.mockup-studio]', 'command = "x"', 'x.y = 1', '', '[o]');
    expect(keys(d)).toEqual(['command@1-2', 'x.y@2-3']);
    setEnv(d, { B: '2' }, tomlString);
    expect(renderDoc(d)).toBe(
      '[mcp_servers.mockup-studio]\ncommand = "x"\nx.y = 1\n\n[mcp_servers.mockup-studio.env]\nB = "2"\n\n[o]',
    );
    const e = doc('[mcp_servers.mockup-studio]', 'url = "u"', 'env . "A" = "1"', 'env.B = "2"');
    expect(removeKeyOrTable(e, 'env')).toEqual(['env.A', 'env.B']);
    expect(renderDoc(e)).toBe('[mcp_servers.mockup-studio]\nurl = "u"');
  });
  it('unreadable inline env: throws', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'env = "not a table"');
    expect(() => setEnv(d, { A: '1' }, tomlString)).toThrow(/env/);
  });
});

describe('tomlError and readServerTable', () => {
  it('error with line and column', () => {
    expect(tomlError('a = 1\na = 2\n')).toMatch(/^line 2, column 1: /);
    expect(tomlError('a = 1\n')).toBeNull();
  });
  it('reads """, inline env and comments like Codex', () => {
    const t = readServerTable(
      [
        '[mcp_servers.mockup-studio]',
        'command = """mockup"""',
        "args = [ # c\n  'mcp', # d\n]",
        'env = { A = "1" }',
      ].join('\n'),
      'mockup-studio',
    );
    expect(t).toEqual({ command: 'mockup', args: ['mcp'], env: { A: '1' } });
  });
});
