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
  it('comentário no fim da linha, fora de string', () => {
    expect(scanValue(' "a#b" # c')).toEqual({ complete: true, comment: '# c' });
    expect(scanValue(" 'x' ")).toEqual({ complete: true, comment: undefined });
  });
  it('array com comentário dentro continua até fechar', () => {
    expect(scanValue(' [ # c ]').complete).toBe(false);
    expect(scanValue(' [ # c ]\n "a",\n] # fim')).toEqual({ complete: true, comment: '# fim' });
  });
  it('string de várias linhas', () => {
    expect(scanValue(' """abc').complete).toBe(false);
    expect(scanValue(' """abc\n[x] = 1\n"""').complete).toBe(true);
    expect(scanValue(" '''a\\'''").complete).toBe(true);
    expect(scanValue(' """a\\"""\n"""').complete).toBe(true);
  });
});

describe('findSection', () => {
  it('array em várias linhas com comentário dentro', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'args = [ # lista', '  "a", # um', ']', 'x = 1');
    expect(keys(d)).toEqual(['args@1-4', 'x@4-5']);
  });
  it('string """ com linha que parece cabeçalho ou chave', () => {
    const d = doc(
      '[mcp_servers.mockup-studio]',
      'command = """',
      '[falso]',
      'url = "não"',
      '"""',
      'args = []',
      '[mcp_servers.outro]',
    );
    expect(keys(d)).toEqual(['command@1-5', 'args@5-6']);
    expect(findSection(d)?.end).toBe(6);
  });
  it('subtabela env com cabeçalho entre aspas', () => {
    const d = doc('[mcp_servers."mockup-studio".env] # c', 'A = "1"');
    expect(keys(d, 'env')).toEqual(['A@1-2']);
  });
});

describe('setKey', () => {
  it('preserva o comentário do fim da linha e é idempotente', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'command = "velho" # meu comentário', '');
    expect(setKey(d, 'command', '"novo"')).toBe(true);
    expect(d.lines[1]).toBe('command = "novo" # meu comentário');
    expect(setKey(d, 'command', '"novo"')).toBe(false);
  });
  it('troca array de várias linhas por uma linha, mantendo o comentário final', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'args = [ # x', '  "a",', '] # fim', 'y = 2');
    setKey(d, 'args', '["mcp"]');
    expect(renderDoc(d)).toBe('[mcp_servers.mockup-studio]\nargs = ["mcp"] # fim\ny = 2');
  });
  it('troca string """ inteira', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'command = """', 'a', '"""', 'z = 1');
    setKey(d, 'command', '"b"');
    expect(renderDoc(d)).toBe('[mcp_servers.mockup-studio]\ncommand = "b"\nz = 1');
  });
});

describe('removeKeyOrTable', () => {
  it('remove a chave em linha e a subtabela, mantendo as outras seções e a quebra final', () => {
    const d = doc(
      '[mcp_servers.mockup-studio]',
      'command = "x"',
      'env = { A = "1" }',
      '',
      '[mcp_servers.mockup-studio.env]',
      'B = "2"',
      '',
      '[mcp_servers.outro]',
      'command = "o"',
      '',
    );
    expect(removeKeyOrTable(d, 'env')).toEqual(['env', '[mcp_servers.mockup-studio.env]']);
    expect(renderDoc(d)).toBe(
      '[mcp_servers.mockup-studio]\ncommand = "x"\n\n[mcp_servers.outro]\ncommand = "o"\n',
    );
  });
  it('subtabela no fim do arquivo', () => {
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
  it('env em linha: reescreve em linha, sem criar subtabela', () => {
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
  it('sem env: cria a subtabela depois da seção', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'command = "x"', '', '[outro]', '');
    setEnv(d, { A: '1' }, tomlString);
    expect(renderDoc(d)).toBe(
      '[mcp_servers.mockup-studio]\ncommand = "x"\n\n[mcp_servers.mockup-studio.env]\nA = "1"\n\n[outro]\n',
    );
  });
  it('env com chave pontilhada: lança; a subtabela nova vai para o fim da seção', () => {
    expect(() =>
      setEnv(doc('[mcp_servers.mockup-studio]', 'env.A = "1"'), { B: '2' }, tomlString),
    ).toThrow(/pontilhadas/);
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
  it('env em linha ilegível: lança', () => {
    const d = doc('[mcp_servers.mockup-studio]', 'env = "não é tabela"');
    expect(() => setEnv(d, { A: '1' }, tomlString)).toThrow(/env/);
  });
});

describe('tomlError e readServerTable', () => {
  it('erro com linha e coluna', () => {
    expect(tomlError('a = 1\na = 2\n')).toMatch(/^linha 2, coluna 1: /);
    expect(tomlError('a = 1\n')).toBeNull();
  });
  it('lê """, env em linha e comentários como o Codex', () => {
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
