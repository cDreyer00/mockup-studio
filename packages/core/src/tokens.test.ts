import { describe, expect, it } from 'vitest';
import { applyOps } from './apply.js';
import { getComputedLike } from './computed.js';
import { createDocument, createNode } from './document.js';
import { History } from './history.js';
import type { Op } from './ops.js';
import {
  effectiveTheme,
  findVarRefs,
  getTokenReport,
  inferTokenGroup,
  planApplyToken,
  planCreateTheme,
  planDeleteTheme,
  planDeleteTokens,
  planRenameTheme,
  planSetFrameTheme,
  replaceVarRefs,
  resolvedTokens,
  resolveScope,
  resolveTokenValue,
  substituteVars,
  themeDeclarations,
  tokenGroup,
  validateTokenValue,
} from './tokens.js';
import type { Document, Node } from './types.js';

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

function el(id: string, style: Record<string, string> = {}, children: Node[] = []): Node {
  return createNode({ tag: 'div', id, name: id, style, children });
}

/** Documento com um frame `fr_main0001` (filhos dados) e tokens/temas opcionais. */
function docWith(
  children: Node[],
  extra: Partial<Pick<Document, 'tokens' | 'tokenMeta' | 'themes'>> = {},
  frameAttrs: Record<string, string> = {},
): Document {
  const doc = createDocument('Teste', { id: 'doc_test0001' });
  doc.pages[0].frames.push(
    createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_main0001',
      name: 'Tela',
      attrs: frameAttrs,
      style: { width: '400px' },
      children,
    }),
  );
  Object.assign(doc, extra);
  return doc;
}

/** Aplica pelo History, confere undo exato e redo, e devolve o documento depois das ops. */
function applyAndUndo(doc: Document, ops: Op[]): Document {
  const h = new History(structuredClone(doc));
  const after = h.apply(ops).doc;
  expect(strip(h.undo()!.doc)).toEqual(strip(doc));
  expect(strip(h.redo()!.doc)).toEqual(strip(after));
  return after;
}

describe('resolução de variáveis', () => {
  it('alias simples e cadeia', () => {
    const doc = docWith([], {
      tokens: { '--a': '#111', '--b': 'var(--a)', '--c': 'var(--b)' },
    });
    expect(resolvedTokens(doc)['--b']).toBe('#111');
    expect(resolveTokenValue(doc, 'c')).toBe('#111');
  });

  it('fallback quando a variável não existe', () => {
    expect(substituteVars('var(--x, 4px)', () => undefined)).toEqual({ value: '4px', missing: [] });
    expect(substituteVars('var(--x)', () => undefined).missing).toEqual(['--x']);
    expect(findVarRefs('var(--x, var(--y, 1px))').map((r) => r.name)).toEqual(['--x', '--y']);
  });

  it('ciclo não trava e deixa as variáveis sem valor', () => {
    const doc = docWith([], { tokens: { '--a': 'var(--b)', '--b': 'var(--a)', '--ok': '1px' } });
    const r = resolvedTokens(doc);
    expect(r['--ok']).toBe('1px');
    expect(Object.keys(r)).not.toContain('--a');
    expect(resolveTokenValue(doc, '--a')).toBeUndefined();
    expect(resolveScope({}, { '--a': 'var(--a)' })).toEqual({});
  });

  it('custom property local do ancestral sobrescreve o token', () => {
    const doc = docWith(
      [el('el_pai00001', { '--c': 'blue' }, [el('el_filho001', { color: 'var(--c)' })])],
      { tokens: { '--c': 'red' } },
    );
    expect(getComputedLike(doc, 'el_filho001').color).toBe('blue');
  });

  it('tema no frame muda o valor resolvido de alias dependente', () => {
    const doc = docWith(
      [el('el_filho001', { background: 'var(--surface)' })],
      {
        tokens: { '--gray-50': '#fafafa', '--surface': 'var(--gray-50)' },
        themes: [{ name: 'dark', overrides: { '--gray-50': '#111111' } }],
      },
      { 'data-theme': 'dark' },
    );
    expect(getComputedLike(doc, 'el_filho001').background).toBe('#111111');
    expect(effectiveTheme(doc, 'el_filho001')).toBe('dark');
    expect(resolvedTokens(doc)['--surface']).toBe('#fafafa');
    expect(resolvedTokens(doc, 'dark')['--surface']).toBe('#111111');
    // tema desconhecido no atributo é ignorado
    const semTema = docWith([el('el_filho001')], { tokens: {} }, { 'data-theme': 'nada' });
    expect(effectiveTheme(semTema, 'el_filho001')).toBeUndefined();
  });

  it('themeDeclarations inclui os tokens base que dependem das overrides', () => {
    const doc = docWith([], {
      tokens: { '--gray-50': '#fafafa', '--surface': 'var(--gray-50)', '--x': '1px' },
      themes: [{ name: 'dark', overrides: { '--gray-50': '#111' } }],
    });
    expect(themeDeclarations(doc, 'dark')).toEqual({
      '--surface': 'var(--gray-50)',
      '--gray-50': '#111',
    });
    expect(themeDeclarations(doc, 'nada')).toEqual({});
  });

  it('getComputedLike avalia calc() e color-mix(), com opção evaluate:false', () => {
    const doc = docWith(
      [
        el('el_a0000001', {
          padding: 'calc(var(--space) * 2)',
          color: 'color-mix(in srgb, var(--c) 50%, transparent)',
        }),
      ],
      { tokens: { '--space': '8px', '--c': '#ff0000' } },
    );
    const c = getComputedLike(doc, 'el_a0000001');
    expect(c.padding).toBe('16px');
    expect(c.color).toMatch(/^#ff000080$/i);
    const raw = getComputedLike(doc, 'el_a0000001', { evaluate: false });
    expect(raw.padding).toBe('calc(8px * 2)');
    expect(raw.color).toContain('color-mix(');
  });

  it('getComputedLike com a opção theme', () => {
    const doc = docWith([el('el_a0000001', { color: 'var(--c)' })], {
      tokens: { '--c': 'white' },
      themes: [{ name: 'dark', overrides: { '--c': 'black' } }],
    });
    expect(getComputedLike(doc, 'el_a0000001').color).toBe('white');
    expect(getComputedLike(doc, 'el_a0000001', { theme: 'dark' }).color).toBe('black');
  });
});

describe('renameToken', () => {
  function rich(): Document {
    const doc = docWith(
      [
        el('el_a0000001', {
          color: 'var(--old)',
          '--old-extra': '1px',
          border: '1px solid var(--old-extra, red)',
        }),
        el('el_b0000002', { '--old': 'green', background: 'var(--old, #000)' }),
      ],
      {
        tokens: {
          '--old': '#123456',
          '--old-extra': '2px',
          '--dep': 'var(--old)',
          '--keep': '3px',
        },
        tokenMeta: { '--old': { group: 'color', description: 'cor' } },
        themes: [{ name: 'dark', overrides: { '--old': '#abcdef', '--dep2': 'var(--old)' } }],
      },
    );
    doc.pages.push({
      id: 'pg_segunda1',
      name: 'Outra',
      background: '#fff',
      frames: [
        createNode({
          tag: 'div',
          type: 'frame',
          id: 'fr_outro001',
          children: [el('el_c0000003', { color: 'var( --old )' })],
        }),
      ],
    });
    return doc;
  }

  it('atualiza tokens, metadados, temas e estilos em várias páginas', () => {
    const { doc: out } = applyOps(rich(), [{ type: 'renameToken', from: 'old', to: '--novo' }]);
    expect(out.tokens['--novo']).toBe('#123456');
    expect('--old' in out.tokens).toBe(false);
    expect(out.tokens['--dep']).toBe('var(--novo)');
    expect(out.tokenMeta).toEqual({ '--novo': { group: 'color', description: 'cor' } });
    expect(out.themes![0].overrides).toEqual({ '--novo': '#abcdef', '--dep2': 'var(--novo)' });
    const a = out.pages[0].frames[0].children[0].style;
    expect(a.color).toBe('var(--novo)');
    // nome com prefixo igual não é tocado
    expect(a['--old-extra']).toBe('1px');
    expect(a.border).toBe('1px solid var(--old-extra, red)');
    expect(out.tokens['--old-extra']).toBe('2px');
    const b = out.pages[0].frames[0].children[1].style;
    expect(b['--novo']).toBe('green');
    expect(b.background).toBe('var(--novo, #000)');
    expect(out.pages[1].frames[0].children[0].style.color).toBe('var(--novo )');
  });

  it('erros: destino existe, origem não existe, nome inválido', () => {
    const doc = rich();
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--old', to: '--keep' }])).toThrow(
      /existe/,
    );
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--nada', to: '--x' }])).toThrow(
      /não encontrado/,
    );
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--old', to: '--a b' }])).toThrow(
      /inválido/,
    );
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--old', to: '--old' }])).toThrow();
  });

  it('undo restaura o documento exatamente e redo reaplica', () => {
    const after = applyAndUndo(rich(), [{ type: 'renameToken', from: '--old', to: '--novo' }]);
    expect(after.tokens['--novo']).toBe('#123456');
  });
});

describe('ops de tokens e temas', () => {
  const base = (): Document =>
    docWith([], {
      tokens: { '--a': '1px' },
      themes: [{ name: 'dark', overrides: { '--a': '2px' } }],
    });

  it('setTokens com theme escreve nas overrides e desfaz', () => {
    const after = applyAndUndo(base(), [
      { type: 'setTokens', theme: 'dark', set: { b: '3px' }, unset: ['--a'] },
    ]);
    expect(after.themes![0].overrides).toEqual({ '--b': '3px' });
    expect(after.tokens).toEqual({ '--a': '1px' });
  });

  it('setTokens com tema inexistente falha', () => {
    expect(() =>
      applyOps(base(), [{ type: 'setTokens', theme: 'nada', set: { '--a': '1px' } }]),
    ).toThrow(/não encontrado/);
  });

  it('setTokens recusa valor que escapa da declaração', () => {
    expect(() =>
      applyOps(base(), [{ type: 'setTokens', set: { '--a': 'red; color: blue' } }]),
    ).toThrow();
  });

  it('setTokenMeta define, remove e limpa o campo vazio', () => {
    const after = applyAndUndo(base(), [
      { type: 'setTokenMeta', set: { a: { group: 'spacing', description: 'x' } } },
    ]);
    expect(after.tokenMeta).toEqual({ '--a': { group: 'spacing', description: 'x' } });
    const h = new History(after);
    const sem = h.apply([{ type: 'setTokenMeta', unset: ['--a'] }]).doc;
    expect('tokenMeta' in sem).toBe(false);
    h.undo();
    expect(strip(h.doc)).toEqual(strip(after));
    // entrada vazia equivale a remover
    const vazio = applyOps(after, [{ type: 'setTokenMeta', set: { '--a': {} } }]).doc;
    expect('tokenMeta' in vazio).toBe(false);
  });

  it('setThemes troca a lista, remove o campo quando vazia e desfaz', () => {
    const after = applyAndUndo(base(), [
      { type: 'setThemes', themes: [{ name: 'light', overrides: {} }] },
    ]);
    expect(after.themes).toEqual([{ name: 'light', overrides: {} }]);
    const none = applyAndUndo(base(), [{ type: 'setThemes', themes: [] }]);
    expect('themes' in none).toBe(false);
  });

  it('setThemes recusa nome inválido e duplicado', () => {
    expect(() =>
      applyOps(base(), [{ type: 'setThemes', themes: [{ name: 'a b', overrides: {} }] }]),
    ).toThrow();
    expect(() =>
      applyOps(base(), [
        {
          type: 'setThemes',
          themes: [
            { name: 'x', overrides: {} },
            { name: 'x', overrides: {} },
          ],
        },
      ]),
    ).toThrow();
  });

  it('replaceTokens troca tudo e desfaz', () => {
    const after = applyAndUndo(base(), [
      {
        type: 'replaceTokens',
        tokens: { n: '5px' },
        tokenMeta: { '--n': { group: 'spacing' } },
        themes: [{ name: 'alto', overrides: { '--n': '9px' } }],
      },
    ]);
    expect(after.tokens).toEqual({ '--n': '5px' });
    expect(after.themes![0].name).toBe('alto');
    const limpo = applyAndUndo(base(), [{ type: 'replaceTokens', tokens: {} }]);
    expect('themes' in limpo).toBe(false);
    expect('tokenMeta' in limpo).toBe(false);
  });
});

describe('planejadores', () => {
  const base = (): Document =>
    docWith(
      [el('el_a0000001')],
      {
        tokens: { '--a': '1px', '--b': '2px' },
        tokenMeta: { '--a': { group: 'spacing' } },
        themes: [{ name: 'dark', overrides: { '--a': '9px' } }],
      },
      { 'data-theme': 'dark' },
    );

  it('planDeleteTokens remove de base, metadados e temas', () => {
    const doc = base();
    const out = applyAndUndo(doc, planDeleteTokens(doc, ['a']));
    expect(out.tokens).toEqual({ '--b': '2px' });
    expect('tokenMeta' in out).toBe(false);
    expect(out.themes![0].overrides).toEqual({});
    expect(() => planDeleteTokens(doc, ['--nada'])).toThrow(/não encontrado/);
  });

  it('planApplyToken gera var(--x) e recusa token inexistente', () => {
    const doc = base();
    const out = applyOps(doc, planApplyToken(doc, ['el_a0000001'], 'backgroundColor', 'b')).doc;
    expect(out.pages[0].frames[0].children[0].style['background-color']).toBe('var(--b)');
    expect(() => planApplyToken(doc, ['el_a0000001'], 'color', '--nada')).toThrow(/não existe/);
    expect(() => planApplyToken(doc, ['el_zzzzzzzz'], 'color', '--a')).toThrow(/não encontrado/);
  });

  it('criar, renomear e remover tema atualizam data-theme dos nós', () => {
    const doc = base();
    const criado = applyOps(
      doc,
      planCreateTheme(doc, 'hc', { copyFrom: 'dark', overrides: { b: '7px' } }),
    ).doc;
    expect(criado.themes![1]).toEqual({ name: 'hc', overrides: { '--a': '9px', '--b': '7px' } });
    expect(() => planCreateTheme(doc, 'dark')).toThrow(/Já existe/);
    expect(() => planCreateTheme(doc, 'a b')).toThrow(/inválido/);

    const ren = applyAndUndo(doc, planRenameTheme(doc, 'dark', 'noite'));
    expect(ren.themes![0].name).toBe('noite');
    expect(ren.pages[0].frames[0].attrs['data-theme']).toBe('noite');

    const del = applyAndUndo(doc, planDeleteTheme(doc, 'dark'));
    expect('themes' in del).toBe(false);
    expect('data-theme' in del.pages[0].frames[0].attrs).toBe(false);
    expect(() => planDeleteTheme(doc, 'nada')).toThrow(/não encontrado/);
  });

  it('planSetFrameTheme define e, com null, remove', () => {
    const doc = base();
    const sem = applyOps(doc, planSetFrameTheme(doc, ['fr_main0001'], null)).doc;
    expect('data-theme' in sem.pages[0].frames[0].attrs).toBe(false);
    const com = applyOps(sem, planSetFrameTheme(sem, ['fr_main0001'], 'dark')).doc;
    expect(com.pages[0].frames[0].attrs['data-theme']).toBe('dark');
    expect(() => planSetFrameTheme(doc, ['fr_main0001'], 'nada')).toThrow();
  });
});

describe('getTokenReport', () => {
  it('uso por nós e por tokens, e não usados', () => {
    const doc = docWith(
      [
        el('el_a0000001', { color: 'var(--a)' }),
        el('el_b0000002', { background: 'var(--a)', margin: 'var(--c)' }),
      ],
      { tokens: { '--a': '#fff', '--b': 'var(--a)', '--c': '1px', '--sobra': '3px' } },
    );
    const r = getTokenReport(doc);
    const a = r.tokens.find((t) => t.name === '--a')!;
    expect(a.usage.nodeIds).toEqual(['el_a0000001', 'el_b0000002']);
    expect(a.usage.tokens).toEqual(['--b']);
    expect(r.unused.sort()).toEqual(['--b', '--sobra']);
    expect(r.broken).toEqual([]);
    expect(a.group).toBe('color');
    expect(a.resolved).toBe('#fff');
  });

  it('referências quebradas em token, tema e estilo; custom property do ancestral não conta', () => {
    const doc = docWith(
      [
        el('el_pai00001', { '--local': '4px' }, [
          el('el_filho001', {
            padding: 'var(--local)',
            margin: 'var(--falta)',
            gap: 'var(--falta2, 1px)',
          }),
        ]),
      ],
      {
        tokens: { '--a': 'var(--sumiu)' },
        themes: [{ name: 'dark', overrides: { '--a': 'var(--sumiu2)' } }],
      },
    );
    const broken = getTokenReport(doc).broken;
    expect(broken).toContainEqual({ token: '--a', missing: '--sumiu' });
    expect(broken).toContainEqual({ token: '--a', theme: 'dark', missing: '--sumiu2' });
    expect(broken).toContainEqual({
      nodeId: 'el_filho001',
      property: 'margin',
      missing: '--falta',
    });
    expect(broken).toHaveLength(3);
  });

  it('problema de validação, valores por tema e descrição', () => {
    const doc = docWith([], {
      tokens: { '--color-x': '12px', '--color-ok': '#fff' },
      tokenMeta: { '--color-ok': { description: 'ok' } },
      themes: [{ name: 'dark', overrides: { '--color-ok': '#000' } }],
    });
    const r = getTokenReport(doc);
    const x = r.tokens.find((t) => t.name === '--color-x')!;
    expect(x.problem?.level).toBe('warning');
    const ok = r.tokens.find((t) => t.name === '--color-ok')!;
    expect(ok.problem).toBeUndefined();
    expect(ok.description).toBe('ok');
    expect(ok.themes).toEqual({ dark: '#000' });
    expect(ok.resolvedByTheme).toEqual({ dark: '#000' });
    expect(r.themes).toEqual([{ name: 'dark', overrides: 1, frames: [] }]);
  });
});

describe('validateTokenValue', () => {
  it('aceita color-mix e calc válidos', () => {
    expect(validateTokenValue('--color-a', 'color-mix(in srgb, #fff 50%, #000)')).toBeNull();
    expect(validateTokenValue('--space-a', 'calc(1px + 2px)')).toBeNull();
  });

  it('parênteses abertos são erro', () => {
    expect(validateTokenValue('--space-a', 'calc(1px + 2px')?.level).toBe('error');
  });

  it('tipo errado é warning', () => {
    expect(validateTokenValue('--color-a', '12px')?.level).toBe('warning');
    expect(validateTokenValue('--space-a', 'banana')?.level).toBe('warning');
  });

  it('referência inexistente é warning', () => {
    const p = validateTokenValue('--color-a', 'var(--nada)', { vars: {} });
    expect(p?.level).toBe('warning');
    expect(p?.message).toContain('--nada');
    expect(validateTokenValue('--color-a', 'var(--c)', { vars: { '--c': '#fff' } })).toBeNull();
  });

  it('valores perigosos e vazios são erro', () => {
    for (const v of ['red}', 'red; color: blue', '<b>', '']) {
      expect(validateTokenValue('--x', v)?.level, v).toBe('error');
    }
  });
});

describe('grupos', () => {
  it('inferTokenGroup pelos prefixos', () => {
    expect(inferTokenGroup('--color-primary')).toBe('color');
    expect(inferTokenGroup('--bg-card')).toBe('color');
    expect(inferTokenGroup('--shadow-md')).toBe('shadow');
    expect(inferTokenGroup('--radius')).toBe('radius');
    expect(inferTokenGroup('--font-sans')).toBe('typography');
    expect(inferTokenGroup('--text-lg')).toBe('typography');
    expect(inferTokenGroup('--spacing-4')).toBe('spacing');
    expect(inferTokenGroup('--zzz')).toBe('other');
  });

  it('inferTokenGroup pelo valor', () => {
    expect(inferTokenGroup('--zzz', '#abc')).toBe('color');
    expect(inferTokenGroup('--zzz', 'oklch(0.5 0.2 200)')).toBe('color');
    expect(inferTokenGroup('--zzz', '0 1px 2px rgba(0,0,0,.2)')).toBe('shadow');
    expect(inferTokenGroup('--zzz', '12px')).toBe('spacing');
    expect(inferTokenGroup('--zzz', 'abc')).toBe('other');
  });

  it('tokenGroup prefere os metadados', () => {
    const doc = docWith([], {
      tokens: { '--a': '#fff' },
      tokenMeta: { '--a': { group: 'marca' } },
    });
    expect(tokenGroup(doc, '--a')).toBe('marca');
  });

  it('replaceVarRefs só troca o nome exato', () => {
    expect(replaceVarRefs('var(--a) var(--a-b) var(--a, 1px)', '--a', '--z')).toBe(
      'var(--z) var(--a-b) var(--z, 1px)',
    );
  });
});
