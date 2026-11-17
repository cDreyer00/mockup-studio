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
    '--dead': 'var(--does-not-exist)',
    '--custom': '1',
  };
  doc.tokenMeta = { '--custom': { group: 'zeta' }, '--space-2': { description: 'base' } };
  doc.themes = [{ name: 'dark', overrides: { '--color-bg': '#111111' } }];
  const box = createNodeFromTag('div', { styles: { background: 'var(--color-bg)' } });
  doc.pages[0]!.frames.push(createNodeFromTag('div', { isRoot: true, children: [box] }));
  return doc;
}

describe('varRefName', () => {
  it('detects a whole var(--x)', () => {
    expect(varRefName('var(--a)')).toBe('--a');
    expect(varRefName(' var(--a-b_1, 4px) ')).toBe('--a-b_1');
    expect(varRefName('calc(var(--a) * 2)')).toBeNull();
    expect(varRefName('1px solid var(--a)')).toBeNull();
    expect(varRefName(undefined)).toBeNull();
  });
});

describe('bindKindFor', () => {
  it('maps properties to the token type', () => {
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

describe('grouping and search', () => {
  const report = getTokenReport(sample());

  it('built-in groups in order and free groups at the end', () => {
    const ids = groupTokens(report.tokens).map((g) => g.id);
    expect(ids.slice(0, 4)).toEqual(['color', 'typography', 'spacing', 'radius']);
    expect(ids[ids.length - 1]).toBe('zeta');
  });

  it('search by name and by value', () => {
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

  it('picker: relevant group first and "all" includes the rest', () => {
    const only = pickerTokens(report.tokens, ['radius'], false, '');
    expect(only.map((t) => t.name)).toEqual(['--radius-md']);
    const all = pickerTokens(report.tokens, ['radius'], true, '');
    expect(all[0]!.name).toBe('--radius-md');
    expect(all.length).toBe(report.tokens.length);
  });
});

describe('row state', () => {
  const doc = sample();
  const report = getTokenReport(doc);
  const info = (n: string) => report.tokens.find((t) => t.name === n)!;

  it('value per theme and override', () => {
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

  it('a broken reference becomes a problem; the summary counts unused', () => {
    expect(rowProblem(info('--dead'), report)).not.toBeNull();
    const s = summarizeTokens(report);
    expect(s.tokens).toBe(8);
    expect(s.themes).toBe(1);
    expect(s.unused).toBeGreaterThan(0);
    expect(s.broken).toBeGreaterThanOrEqual(1);
  });

  it('previews', () => {
    expect(previewFor('color', '--c', '#fff')?.kind).toBe('color');
    expect(previewFor('spacing', '--s', '8px')?.kind).toBe('spacing');
    expect(previewFor('radius', '--r', '6px')?.kind).toBe('radius');
    expect(previewFor('shadow', '--sh', '0 1px 2px #000')?.kind).toBe('shadow');
    expect(previewFor('typography', '--font-body', 'Inter')?.kind).toBe('font');
    expect(previewFor('color', '--c', undefined)).toBeNull();
  });
});

describe('validation and ops', () => {
  const doc = sample();

  it('validates token and theme names', () => {
    expect(tokenNameError(doc, 'new')).toBeNull();
    expect(tokenNameError(doc, 'color-primary')).toMatch(/already exists/);
    expect(tokenNameError(doc, 'with space')).not.toBeNull();
    expect(tokenNameError(doc, '--color-primary', '--color-primary')).toBeNull();
    expect(themeNameError(doc, 'light')).toBeNull();
    expect(themeNameError(doc, 'dark')).toMatch(/already exists/);
    expect(themeNameError(doc, 'a b')).not.toBeNull();
  });

  it('rename rejects a target that already exists in a theme or is declared in a node style', () => {
    const d = sample();
    d.themes = [{ name: 'dark', overrides: { '--color-bg': '#111111', '--theme-only': '#000' } }];
    const local = createNodeFromTag('div', { styles: { '--local': '1px' } });
    d.pages[0]!.frames.push(createNodeFromTag('div', { isRoot: true, children: [local] }));
    expect(tokenNameError(d, 'theme-only', '--brand')).toMatch(/already exists/);
    expect(tokenNameError(d, 'local', '--brand')).toMatch(/already declared/);
    expect(() => planRenameToken(d, '--brand', 'local')).toThrow(/already declared/);
    expect(() => planRenameToken(d, '--brand', 'theme-only')).toThrow(/already exists/);
    expect(planRenameToken(d, '--brand', 'free')).toHaveLength(1);
  });

  it('validateEdit: an error blocks, a warning passes', () => {
    expect(validateEdit(doc, '--color-primary', 'rgb(1,2')?.level).toBe('error');
    expect(validateEdit(doc, '--color-primary', 'green-banana')?.level).toBe('warning');
    expect(validateEdit(doc, '--color-primary', '#abcdef')).toBeNull();
  });

  it('creates a token with group and description', () => {
    expect(planCreateToken(doc, { name: 'color-new', value: '#fff' })).toEqual([
      { type: 'setTokens', set: { '--color-new': '#fff' } },
    ]);
    expect(
      planCreateToken(doc, { name: 'x', value: '1px', group: 'spacing', description: 'd' }),
    ).toEqual([
      { type: 'setTokens', set: { '--x': '1px' } },
      { type: 'setTokenMeta', set: { '--x': { group: 'spacing', description: 'd' } } },
    ]);
    expect(() => planCreateToken(doc, { name: 'color-bg', value: '#fff' })).toThrow(
      /already exists/,
    );
    expect(() => planCreateToken(doc, { name: 'y', value: '' })).toThrow();
    expect(() => planCreateToken(doc, { name: 'y', value: 'rgb(1,2' })).toThrow();
  });

  it('renames, edits value/theme, override and metadata', () => {
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
    // merges with the existing meta
    expect(opSetMeta(doc, '--space-2', { group: 'spacing' })).toEqual({
      type: 'setTokenMeta',
      set: { '--space-2': { description: 'base', group: 'spacing' } },
    });
    // an empty meta is removed; with no meta and no change no op is generated
    expect(opSetMeta(doc, '--custom', { group: '' })).toEqual({
      type: 'setTokenMeta',
      unset: ['--custom'],
    });
    expect(opSetMeta(doc, '--color-bg', { group: '' })).toBeNull();
  });
});
