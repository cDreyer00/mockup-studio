import { createDocument, createNodeFromTag, getTokenReport } from '@mockup/core';
import type { Document } from '@mockup/core';
import { describe, expect, it } from 'vitest';
import {
  bindKindFor,
  groupTokens,
  groupsForKind,
  opClearOverride,
  opSetMeta,
  opSetValue,
  pickerTokens,
  planCreateToken,
  planRenameToken,
  previewFor,
  rowProblem,
  shownValue,
  summarizeTokens,
  themeNameError,
  tokenNameError,
  validateEdit,
  varRefName,
} from './tokensLogic';

function sample(): Document {
  const doc = createDocument('T');
  doc.tokens = {
    '--color-primary': '#2dd4bf',
    '--color-bg': '#ffffff',
    '--space-2': '8px',
    '--radius-md': '6px',
    '--font-body': 'Inter, sans-serif',
    '--brand': 'var(--color-primary)',
    '--morto': 'var(--nao-existe)',
    '--custom': '1',
  };
  doc.tokenMeta = { '--custom': { group: 'zeta' }, '--space-2': { description: 'base' } };
  doc.themes = [{ name: 'dark', overrides: { '--color-bg': '#111111' } }];
  const box = createNodeFromTag('div', { styles: { background: 'var(--color-bg)' } });
  doc.pages[0]!.frames.push(createNodeFromTag('div', { isRoot: true, children: [box] }));
  return doc;
}

describe('varRefName', () => {
  it('detecta var(--x) inteiro', () => {
    expect(varRefName('var(--a)')).toBe('--a');
    expect(varRefName(' var(--a-b_1, 4px) ')).toBe('--a-b_1');
    expect(varRefName('calc(var(--a) * 2)')).toBeNull();
    expect(varRefName('1px solid var(--a)')).toBeNull();
    expect(varRefName(undefined)).toBeNull();
  });
});

describe('bindKindFor', () => {
  it('mapeia propriedades para o tipo de token', () => {
    expect(bindKindFor('background-color')).toBe('color');
    expect(bindKindFor('color')).toBe('color');
    expect(bindKindFor('border-radius')).toBe('radius');
    expect(bindKindFor('padding')).toBe('spacing');
    expect(bindKindFor('padding-left')).toBe('spacing');
    expect(bindKindFor('gap')).toBe('spacing');
    expect(bindKindFor('width')).toBe('spacing');
    expect(bindKindFor('font-size')).toBe('typography');
    expect(bindKindFor('line-height')).toBe('typography');
    expect(bindKindFor('box-shadow')).toBe('shadow');
    expect(bindKindFor('position')).toBeNull();
    expect(bindKindFor('mix-blend-mode')).toBeNull();
    expect(groupsForKind('radius')).toEqual(['radius', 'spacing']);
  });
});

describe('agrupamento e busca', () => {
  const report = getTokenReport(sample());

  it('grupos nativos na ordem e grupos livres no fim', () => {
    const ids = groupTokens(report.tokens).map((g) => g.id);
    expect(ids.slice(0, 4)).toEqual(['color', 'typography', 'spacing', 'radius']);
    expect(ids[ids.length - 1]).toBe('zeta');
  });

  it('busca por nome e por valor', () => {
    const byName = groupTokens(report.tokens, 'primary').flatMap((g) =>
      g.tokens.map((t) => t.name),
    );
    expect(byName).toEqual(expect.arrayContaining(['--color-primary', '--brand']));
    const byValue = groupTokens(report.tokens, '#111111').flatMap((g) =>
      g.tokens.map((t) => t.name),
    );
    expect(byValue).toEqual(['--color-bg']);
    expect(groupTokens(report.tokens, 'zzzz')).toEqual([]);
  });

  it('seletor: grupo relevante primeiro e "todos" inclui o resto', () => {
    const only = pickerTokens(report.tokens, ['radius'], false, '');
    expect(only.map((t) => t.name)).toEqual(['--radius-md']);
    const all = pickerTokens(report.tokens, ['radius'], true, '');
    expect(all[0]!.name).toBe('--radius-md');
    expect(all.length).toBe(report.tokens.length);
  });
});

describe('estado das linhas', () => {
  const doc = sample();
  const report = getTokenReport(doc);
  const info = (n: string) => report.tokens.find((t) => t.name === n)!;

  it('valor por tema e sobrescrita', () => {
    expect(shownValue(info('--color-bg'), null)).toMatchObject({
      value: '#ffffff',
      overridden: false,
    });
    expect(shownValue(info('--color-bg'), 'dark')).toMatchObject({
      value: '#111111',
      resolved: '#111111',
      overridden: true,
    });
    expect(shownValue(info('--color-primary'), 'dark').overridden).toBe(false);
  });

  it('referência quebrada vira problema; resumo conta não usados', () => {
    expect(rowProblem(info('--morto'), report)).not.toBeNull();
    const s = summarizeTokens(report);
    expect(s.tokens).toBe(8);
    expect(s.themes).toBe(1);
    expect(s.unused).toBeGreaterThan(0);
    expect(s.broken).toBeGreaterThanOrEqual(1);
  });

  it('prévias', () => {
    expect(previewFor('color', '--c', '#fff')?.kind).toBe('color');
    expect(previewFor('spacing', '--s', '8px')?.kind).toBe('spacing');
    expect(previewFor('radius', '--r', '6px')?.kind).toBe('radius');
    expect(previewFor('shadow', '--sh', '0 1px 2px #000')?.kind).toBe('shadow');
    expect(previewFor('typography', '--font-body', 'Inter')?.kind).toBe('font');
    expect(previewFor('color', '--c', undefined)).toBeNull();
  });
});

describe('validação e ops', () => {
  const doc = sample();

  it('valida nomes de token e de tema', () => {
    expect(tokenNameError(doc, 'novo')).toBeNull();
    expect(tokenNameError(doc, 'color-primary')).toMatch(/já existe/);
    expect(tokenNameError(doc, 'com espaço')).not.toBeNull();
    expect(tokenNameError(doc, '--color-primary', '--color-primary')).toBeNull();
    expect(themeNameError(doc, 'light')).toBeNull();
    expect(themeNameError(doc, 'dark')).toMatch(/já existe/);
    expect(themeNameError(doc, 'a b')).not.toBeNull();
  });

  it('rename recusa destino já existente em tema ou declarado em estilo de nó', () => {
    const d = sample();
    d.themes = [{ name: 'dark', overrides: { '--color-bg': '#111111', '--so-tema': '#000' } }];
    const local = createNodeFromTag('div', { styles: { '--local': '1px' } });
    d.pages[0]!.frames.push(createNodeFromTag('div', { isRoot: true, children: [local] }));
    expect(tokenNameError(d, 'so-tema', '--brand')).toMatch(/já existe/);
    expect(tokenNameError(d, 'local', '--brand')).toMatch(/já está declarada/);
    expect(() => planRenameToken(d, '--brand', 'local')).toThrow(/já está declarada/);
    expect(() => planRenameToken(d, '--brand', 'so-tema')).toThrow(/já existe/);
    expect(planRenameToken(d, '--brand', 'livre')).toHaveLength(1);
  });

  it('validateEdit: erro bloqueia, aviso passa', () => {
    expect(validateEdit(doc, '--color-primary', 'rgb(1,2')?.level).toBe('error');
    expect(validateEdit(doc, '--color-primary', 'banana-verde')?.level).toBe('warning');
    expect(validateEdit(doc, '--color-primary', '#abcdef')).toBeNull();
  });

  it('cria token com grupo e descrição', () => {
    expect(planCreateToken(doc, { name: 'color-novo', value: '#fff' })).toEqual([
      { type: 'setTokens', set: { '--color-novo': '#fff' } },
    ]);
    expect(
      planCreateToken(doc, { name: 'x', value: '1px', group: 'spacing', description: 'd' }),
    ).toEqual([
      { type: 'setTokens', set: { '--x': '1px' } },
      { type: 'setTokenMeta', set: { '--x': { group: 'spacing', description: 'd' } } },
    ]);
    expect(() => planCreateToken(doc, { name: 'color-bg', value: '#fff' })).toThrow(/já existe/);
    expect(() => planCreateToken(doc, { name: 'y', value: '' })).toThrow();
    expect(() => planCreateToken(doc, { name: 'y', value: 'rgb(1,2' })).toThrow();
  });

  it('renomeia, edita valor/tema, sobrescrita e metadados', () => {
    expect(planRenameToken(doc, '--color-bg', 'surface')).toEqual([
      { type: 'renameToken', from: '--color-bg', to: '--surface' },
    ]);
    expect(planRenameToken(doc, '--color-bg', '--color-bg')).toEqual([]);
    expect(opSetValue('--a', ' #fff ')).toEqual({ type: 'setTokens', set: { '--a': '#fff' } });
    expect(opSetValue('--a', '#fff', 'dark')).toEqual({
      type: 'setTokens',
      set: { '--a': '#fff' },
      theme: 'dark',
    });
    expect(opClearOverride('--a', 'dark')).toEqual({
      type: 'setTokens',
      unset: ['--a'],
      theme: 'dark',
    });
    // junta com o meta existente
    expect(opSetMeta(doc, '--space-2', { group: 'spacing' })).toEqual({
      type: 'setTokenMeta',
      set: { '--space-2': { description: 'base', group: 'spacing' } },
    });
    // meta vazio é removido; sem meta e sem mudança não gera op
    expect(opSetMeta(doc, '--custom', { group: '' })).toEqual({
      type: 'setTokenMeta',
      unset: ['--custom'],
    });
    expect(opSetMeta(doc, '--color-bg', { group: '' })).toBeNull();
  });
});
