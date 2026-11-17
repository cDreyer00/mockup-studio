import { describe, expect, it } from 'vitest';
import { resolveShortcut } from './resolveShortcut';
import type { KeyInfo, ShortcutCommand } from './resolveShortcut';

function key(
  k: string,
  mods: Partial<Pick<KeyInfo, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {},
  code = '',
): KeyInfo {
  return { key: k, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}
const ctrl = { ctrlKey: true };
const ctrlShift = { ctrlKey: true, shiftKey: true };
const shift = { shiftKey: true };

describe('resolveShortcut', () => {
  it('tools', () => {
    expect(resolveShortcut(key('v'))).toEqual({ type: 'tool', tool: 'select' });
    expect(resolveShortcut(key('h'))).toEqual({ type: 'tool', tool: 'hand' });
    expect(resolveShortcut(key('f'))).toEqual({ type: 'tool', tool: 'frame' });
    expect(resolveShortcut(key('a'))).toEqual({ type: 'tool', tool: 'frame' });
    expect(resolveShortcut(key('r'))).toEqual({ type: 'tool', tool: 'rect' });
    expect(resolveShortcut(key('t'))).toEqual({ type: 'tool', tool: 'text' });
    expect(resolveShortcut(key('V'))).toEqual({ type: 'tool', tool: 'select' });
    expect(resolveShortcut(key('Dead', {}, 'KeyV'))).toEqual({ type: 'tool', tool: 'select' });
    expect(resolveShortcut(key('x'))).toBeNull();
  });

  it('image, save, duplicate, group', () => {
    expect(resolveShortcut(key('K', ctrlShift))).toEqual({ type: 'pickImage' });
    expect(resolveShortcut(key('k', ctrl))).toBeNull();
    expect(resolveShortcut(key('s', ctrl))).toEqual({ type: 'save' });
    expect(resolveShortcut(key('s', { metaKey: true }))).toEqual({ type: 'save' });
    expect(resolveShortcut(key('s', { ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'saveAs',
    });
    expect(resolveShortcut(key('d', ctrl))).toEqual({ type: 'duplicate' });
    expect(resolveShortcut(key('g', ctrl))).toEqual({ type: 'group' });
    expect(resolveShortcut(key('G', ctrlShift))).toEqual({ type: 'ungroup' });
  });

  it('stacking order (brackets by key and by code)', () => {
    expect(resolveShortcut(key(']', ctrl))).toEqual({ type: 'reorder', kind: 'forward' });
    expect(resolveShortcut(key('[', ctrl))).toEqual({ type: 'reorder', kind: 'backward' });
    expect(resolveShortcut(key('}', ctrlShift))).toEqual({ type: 'reorder', kind: 'front' });
    expect(resolveShortcut(key('{', ctrlShift))).toEqual({ type: 'reorder', kind: 'back' });
    expect(resolveShortcut(key('Dead', ctrl, 'BracketRight'))).toEqual({
      type: 'reorder',
      kind: 'forward',
    });
    expect(resolveShortcut(key('Dead', ctrlShift, 'BracketLeft'))).toEqual({
      type: 'reorder',
      kind: 'back',
    });
    // ABNT2: `]` is on Backslash
    expect(resolveShortcut(key(']', ctrl, 'Backslash'))).toEqual({
      type: 'reorder',
      kind: 'forward',
    });
  });

  it('hide and lock', () => {
    expect(resolveShortcut(key('H', ctrlShift))).toEqual({ type: 'toggleHidden' });
    expect(resolveShortcut(key('L', ctrlShift))).toEqual({ type: 'toggleLocked' });
  });

  it('delete and arrows', () => {
    expect(resolveShortcut(key('Delete'))).toEqual({ type: 'delete' });
    expect(resolveShortcut(key('Backspace'))).toEqual({ type: 'delete' });
    expect(resolveShortcut(key('ArrowLeft'))).toEqual({ type: 'nudge', dx: -1, dy: 0 });
    expect(resolveShortcut(key('ArrowRight'))).toEqual({ type: 'nudge', dx: 1, dy: 0 });
    expect(resolveShortcut(key('ArrowUp'))).toEqual({ type: 'nudge', dx: 0, dy: -1 });
    expect(resolveShortcut(key('ArrowDown'))).toEqual({ type: 'nudge', dx: 0, dy: 1 });
    expect(resolveShortcut(key('ArrowLeft', shift))).toEqual({ type: 'nudge', dx: -10, dy: 0 });
    expect(resolveShortcut(key('ArrowDown', shift))).toEqual({ type: 'nudge', dx: 0, dy: 10 });
  });

  it('Esc, Enter, select all', () => {
    expect(resolveShortcut(key('Escape'))).toEqual({ type: 'escape' });
    expect(resolveShortcut(key('Enter'))).toEqual({ type: 'selectChildren' });
    expect(resolveShortcut(key('Enter', shift))).toEqual({ type: 'selectParent' });
    expect(resolveShortcut(key('a', ctrl))).toEqual({ type: 'selectAll' });
  });

  it('undo and redo', () => {
    expect(resolveShortcut(key('z', ctrl))).toEqual({ type: 'undo' });
    expect(resolveShortcut(key('Z', ctrlShift))).toEqual({ type: 'redo' });
    expect(resolveShortcut(key('y', ctrl))).toEqual({ type: 'redo' });
  });

  it('zoom', () => {
    const cases: [KeyInfo, ShortcutCommand][] = [
      [key('+', shift, 'Equal'), { type: 'zoomIn' }],
      [key('=', {}, 'Equal'), { type: 'zoomIn' }],
      [key('-', {}, 'Minus'), { type: 'zoomOut' }],
      [key(')', shift, 'Digit0'), { type: 'zoom100' }],
      [key('!', shift, 'Digit1'), { type: 'zoomFit' }],
      [key('@', shift, 'Digit2'), { type: 'zoomSelection' }],
      [key('0', shift), { type: 'zoom100' }],
      [key('1', shift), { type: 'zoomFit' }],
      [key('2', shift), { type: 'zoomSelection' }],
    ];
    for (const [input, expected] of cases) expect(resolveShortcut(input)).toEqual(expected);
  });

  it('Ctrl+Alt+K creates a component (also via code, with AltGr/layouts)', () => {
    const ctrlAlt = { ctrlKey: true, altKey: true };
    expect(resolveShortcut(key('k', ctrlAlt))).toEqual({ type: 'createComponent' });
    expect(resolveShortcut(key('K', { metaKey: true, altKey: true }))).toEqual({
      type: 'createComponent',
    });
    expect(resolveShortcut(key('Dead', ctrlAlt, 'KeyK'))).toEqual({ type: 'createComponent' });
    expect(resolveShortcut(key('k', { ...ctrlAlt, shiftKey: true }))).toBeNull();
    expect(resolveShortcut(key('k', { altKey: true }))).toBeNull();
  });

  it('ignores unmapped combinations', () => {
    expect(resolveShortcut(key('v', { altKey: true }))).toBeNull();
    expect(resolveShortcut(key('v', ctrl))).toBeNull();
    expect(resolveShortcut(key(' ', {}, 'Space'))).toBeNull();
    expect(resolveShortcut(key('Alt', { altKey: true }))).toBeNull();
    expect(resolveShortcut(key('ArrowLeft', ctrl))).toBeNull();
  });
});
