import { describe, expect, it } from 'vitest';
import { colorLightness, colorScale, COLOR_STOPS } from './color.js';

const HEX = /^#[0-9a-f]{6}$/;
const lightness = (hex: string): number => colorLightness(hex)!;

describe('colorScale', () => {
  it('returns 10 shades at stops 50..900 in hex', () => {
    const scale = colorScale('#3b82f6');
    expect(scale.map((s) => s.stop)).toEqual([50, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(scale.map((s) => s.stop)).toEqual([...COLOR_STOPS]);
    for (const s of scale) expect(s.color).toMatch(HEX);
  });

  it('lightness falls from 50 to 900 (50 very light, 900 very dark)', () => {
    for (const base of ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#7c3aed', '#64748b']) {
      const ls = colorScale(base).map((s) => lightness(s.color));
      for (let i = 1; i < ls.length; i++)
        expect(ls[i], `${base} stop ${i}`).toBeLessThan(ls[i - 1]!);
      expect(ls[0]).toBeGreaterThan(0.93);
      expect(ls[9]).toBeLessThan(0.36);
    }
  });

  it('is deterministic', () => {
    expect(colorScale('#3b82f6')).toEqual(colorScale('#3b82f6'));
  });

  it('the base lands exactly on the stop with the closest lightness', () => {
    const scale = colorScale('#3b82f6');
    expect(scale.find((s) => s.color === '#3b82f6')?.stop).toBe(500);

    // Light and dark colors fall at the ends of the scale.
    expect(colorScale('#fef2f2').find((s) => s.color === '#fef2f2')?.stop).toBe(50);
    expect(colorScale('#1e1b4b').find((s) => s.color === '#1e1b4b')?.stop).toBe(900);

    // The base stop is the one with the closest lightness among the 10 shades.
    const base = '#f59e0b';
    const s2 = colorScale(base);
    const anchor = s2.find((s) => s.color === base)!;
    const dist = (c: string): number => Math.abs(lightness(c) - lightness(base));
    expect(anchor.stop).toBe(300);
    expect(dist(anchor.color)).toBe(0);
  });

  it('keeps the base hue in the other shades', () => {
    const hueOf = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      return Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * (180 / Math.PI);
    };
    const scale = colorScale('#3b82f6');
    for (const s of scale.slice(1, 9))
      expect(Math.abs(hueOf(s.color) - hueOf('#3b82f6'))).toBeLessThan(12);
  });

  it('grays stay neutral (r = g = b)', () => {
    for (const s of colorScale('#808080')) {
      expect(s.color.slice(1, 3)).toBe(s.color.slice(3, 5));
      expect(s.color.slice(3, 5)).toBe(s.color.slice(5, 7));
    }
  });

  it('accepts rgb(), hsl() and CSS names', () => {
    const ref = colorScale('#3b82f6');
    expect(colorScale('rgb(59, 130, 246)')).toEqual(ref);
    expect(colorScale('  #3B82F6  ')).toEqual(ref);
    expect(colorScale('hsl(217 91% 60%)')).toHaveLength(10);
    const red = colorScale('red');
    expect(red).toHaveLength(10);
    expect(red.some((s) => s.color === '#ff0000')).toBe(true);
  });

  it('white and black produce valid scales', () => {
    for (const base of ['#ffffff', '#000000']) {
      const scale = colorScale(base);
      expect(scale.some((s) => s.color === base)).toBe(true);
      const ls = scale.map((s) => lightness(s.color));
      for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeLessThan(ls[i - 1]!);
    }
  });

  it('invalid inputs throw an error', () => {
    for (const bad of ['', 'bluish', 'var(--brand)', '#12', 'rgb(a,b,c)']) {
      expect(() => colorScale(bad), bad).toThrow(/Invalid color/);
    }
    expect(() => colorScale(undefined as unknown as string)).toThrow(/Invalid color/);
  });
});
