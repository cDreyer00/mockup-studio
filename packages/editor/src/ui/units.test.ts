import { describe, expect, it } from 'vitest';
import { normalizeInput, parseCssNumber } from './units';

describe('units', () => {
  it('parse', () => {
    expect(parseCssNumber('120px')).toEqual({ value: 120, unit: 'px' });
    expect(parseCssNumber('50%')).toEqual({ value: 50, unit: '%' });
    expect(parseCssNumber('1.5')).toEqual({ value: 1.5, unit: '' });
    expect(parseCssNumber('auto')).toBeNull();
  });
  it('normalizeInput', () => {
    expect(normalizeInput('12')).toBe('12px');
    expect(normalizeInput('12', '')).toBe('12');
    expect(normalizeInput(' 2rem ')).toBe('2rem');
    expect(normalizeInput('auto')).toBe('auto');
    expect(normalizeInput('')).toBe('');
    expect(normalizeInput('calc(100% - 8px)')).toBe('calc(100% - 8px)');
  });
});
