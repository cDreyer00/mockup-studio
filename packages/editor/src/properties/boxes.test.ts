import { describe, expect, it } from 'vitest';
import { PADDING, RADIUS, readBox, uniformBox, writeBox } from './boxes';

describe('boxes', () => {
  it('readBox combina shorthand e longhands', () => {
    expect(readBox({ padding: '8px 16px', 'padding-top': '2px' }, PADDING)).toEqual({
      top: '2px',
      right: '16px',
      bottom: '8px',
      left: '16px',
    });
    expect(readBox({}, PADDING)).toEqual({ top: '', right: '', bottom: '', left: '' });
    expect(readBox({ 'border-top-right-radius': '4px' }, RADIUS).right).toBe('4px');
  });
  it('writeBox escreve o shorthand e remove longhands conflitantes', () => {
    const style = { padding: '8px', 'padding-left': '12px' };
    const box = readBox(style, PADDING);
    box.top = '1px';
    expect(writeBox(style, PADDING, box)).toEqual({
      set: { padding: '1px 8px 8px 12px' },
      unset: ['padding-left'],
    });
  });
  it('lados vazios viram 0; box vazio remove', () => {
    expect(writeBox({}, PADDING, { top: '4px', right: '', bottom: '', left: '' }).set).toEqual({
      padding: '4px 0 0',
    });
    expect(writeBox({ padding: '4px', 'padding-top': '1px' }, PADDING, uniformBox(''))).toEqual({
      set: {},
      unset: ['padding', 'padding-top'],
    });
  });
});
