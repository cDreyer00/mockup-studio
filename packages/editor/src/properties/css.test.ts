import { describe, expect, it } from 'vitest';
import {
  diffStyles,
  getFilterFn,
  getRotation,
  parseBorder,
  parseBox,
  parseCssText,
  parseShadow,
  parseShadows,
  serializeBorder,
  serializeBox,
  serializeShadows,
  setFilterFn,
  setRotation,
  splitTopLevel,
  stylesToCssText,
} from './css';

describe('splitTopLevel', () => {
  it('respects parentheses and quotes', () => {
    expect(splitTopLevel('0 0 1px rgba(0,0,0,.2), 0 2px var(--a, #fff)', ',')).toEqual([
      '0 0 1px rgba(0,0,0,.2)',
      ' 0 2px var(--a, #fff)',
    ]);
    expect(splitTopLevel('a;"b;c";d', ';')).toEqual(['a', '"b;c"', 'd']);
  });
  it('space drops empties', () => {
    expect(splitTopLevel('rotate(5deg)  scale(1, 2)', ' ')).toEqual([
      'rotate(5deg)',
      'scale(1, 2)',
    ]);
  });
});

describe('rotation', () => {
  it('reads and writes preserving other functions', () => {
    expect(getRotation('translate(1px, 2px) rotate(45deg)')).toBe(45);
    expect(getRotation('rotate(0.5turn)')).toBe(180);
    expect(getRotation(undefined)).toBe(0);
    expect(setRotation('translate(1px, 2px) rotate(45deg)', 10)).toBe(
      'translate(1px, 2px) rotate(10deg)',
    );
    expect(setRotation('scale(2)', 30)).toBe('scale(2) rotate(30deg)');
    expect(setRotation('rotate(5deg)', 0)).toBe('');
    expect(setRotation(undefined, 15)).toBe('rotate(15deg)');
  });
});

describe('filtros', () => {
  it('get/set preserve other functions', () => {
    expect(getFilterFn('brightness(1.2) blur(4px)', 'blur')).toBe('4px');
    expect(getFilterFn('brightness(1.2)', 'blur')).toBeNull();
    expect(setFilterFn('brightness(1.2) blur(4px)', 'blur', '8px')).toBe(
      'brightness(1.2) blur(8px)',
    );
    expect(setFilterFn('blur(4px)', 'blur', '')).toBe('');
    expect(setFilterFn(undefined, 'blur', '2px')).toBe('blur(2px)');
  });
});

describe('box shorthand', () => {
  it('parse and serialization', () => {
    expect(parseBox('8px')).toEqual({ top: '8px', right: '8px', bottom: '8px', left: '8px' });
    expect(parseBox('8px 16px')).toEqual({
      top: '8px',
      right: '16px',
      bottom: '8px',
      left: '16px',
    });
    expect(parseBox('1px 2px 3px')).toEqual({
      top: '1px',
      right: '2px',
      bottom: '3px',
      left: '2px',
    });
    expect(parseBox('calc(1px + 2px) 4px')?.top).toBe('calc(1px + 2px)');
    expect(parseBox('')).toBeNull();
    expect(parseBox('1px / 2px')).toBeNull();
    expect(serializeBox({ top: '8px', right: '8px', bottom: '8px', left: '8px' })).toBe('8px');
    expect(serializeBox({ top: '8px', right: '16px', bottom: '8px', left: '16px' })).toBe(
      '8px 16px',
    );
    expect(serializeBox({ top: '1px', right: '2px', bottom: '3px', left: '2px' })).toBe(
      '1px 2px 3px',
    );
    expect(serializeBox({ top: '1px', right: '2px', bottom: '3px', left: '4px' })).toBe(
      '1px 2px 3px 4px',
    );
  });
});

describe('border', () => {
  it('parse and serialization', () => {
    expect(parseBorder('1px solid rgba(0, 0, 0, 0.1)')).toEqual({
      width: '1px',
      style: 'solid',
      color: 'rgba(0, 0, 0, 0.1)',
    });
    expect(parseBorder('dashed #fff 2px')).toEqual({
      width: '2px',
      style: 'dashed',
      color: '#fff',
    });
    expect(parseBorder(undefined)).toEqual({ width: '', style: '', color: '' });
    expect(serializeBorder({ width: '1px', style: 'solid', color: '#000' })).toBe('1px solid #000');
    expect(serializeBorder({ width: '', style: 'none', color: '' })).toBe('none');
  });
});

describe('box-shadow', () => {
  it('parse with commas in rgba()', () => {
    const list = parseShadows('0 1px 2px rgba(0,0,0,.2), inset 0 0 0 1px var(--c, #fff)');
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      x: '0',
      y: '1px',
      blur: '2px',
      spread: '',
      color: 'rgba(0,0,0,.2)',
      inset: false,
    });
    expect(list[1]).toMatchObject({ inset: true, spread: '1px', color: 'var(--c, #fff)' });
  });
  it('serializes back', () => {
    const v = '0 1px 2px rgba(0,0,0,.2), inset 0 0 0 1px #fff';
    expect(serializeShadows(parseShadows(v))).toBe(v);
    expect(parseShadows('none')).toEqual([]);
    expect(parseShadow('red')).toBeNull();
  });
});

describe('css bruto', () => {
  it('stylesToCssText e parseCssText', () => {
    const style = { color: 'red', 'background-image': 'url(data:image/png;base64,AAA)' };
    const text = stylesToCssText(style);
    expect(text).toBe('color: red;\nbackground-image: url(data:image/png;base64,AAA);');
    expect(parseCssText(text).style).toEqual(style);
  });
  it('ignores comments and accepts lines without a semicolon', () => {
    const r = parseCssText('/* x; y */\ncolor: red\nfont-family: "A;B", serif; --Tok: 1');
    expect(r.error).toBeUndefined();
    expect(r.style).toEqual({ color: 'red', 'font-family': '"A;B", serif', '--Tok': '1' });
  });
  it('reports invalid lines', () => {
    expect(parseCssText('color red').error).toMatch(/Invalid line/);
    expect(parseCssText('color:').error).toBeDefined();
  });
  it('diffStyles', () => {
    expect(diffStyles({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' })).toEqual({
      set: { b: '9', d: '4' },
      unset: ['c'],
    });
  });
});
