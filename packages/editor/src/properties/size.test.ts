import { createNodeFromTag } from '@mockup/core';
import { describe, expect, it } from 'vitest';
import { sizeMode, sizeModeChange } from './size';

const mk = (styles: Record<string, string>) => createNodeFromTag('div', { styles });

describe('sizeMode', () => {
  const row = mk({ display: 'flex' });
  const col = mk({ display: 'flex', 'flex-direction': 'column' });
  it('detects fixed, auto, 100% and others', () => {
    expect(sizeMode(mk({ width: '120px' }), null, 'width').mode).toBe('fixed');
    expect(sizeMode(mk({}), null, 'width').mode).toBe('auto');
    expect(sizeMode(mk({ height: 'auto' }), null, 'height').mode).toBe('auto');
    expect(sizeMode(mk({ width: '100%' }), null, 'width').mode).toBe('full');
    for (const v of ['fit-content', '50%', '2rem', 'calc(100% - 8px)']) {
      expect(sizeMode(mk({ width: v }), null, 'width')).toEqual({ mode: 'other', value: v });
    }
  });
  it('fill only on the main axis of a flex parent', () => {
    const n = mk({ flex: '1 1 0' });
    expect(sizeMode(n, row, 'width').mode).toBe('fill');
    expect(sizeMode(n, row, 'height').mode).toBe('auto');
    expect(sizeMode(n, col, 'height').mode).toBe('fill');
    expect(sizeMode(n, null, 'width').mode).toBe('auto');
  });
});

describe('sizeModeChange', () => {
  it('fill removes the fixed axis; leaving fill removes flex', () => {
    const n = mk({ width: '100px' });
    expect(sizeModeChange(n, 'width', 'fill', 0)).toEqual({
      set: { flex: '1 1 0' },
      unset: ['width'],
    });
    const f = mk({ flex: '1 1 0' });
    expect(sizeModeChange(f, 'width', 'fixed', 80.4)).toEqual({
      set: { width: '80px' },
      unset: ['flex'],
    });
    expect(sizeModeChange(n, 'width', 'full', 0).set).toEqual({ width: '100%' });
    expect(sizeModeChange(n, 'width', 'auto', 0).unset).toEqual(['width']);
  });
});
