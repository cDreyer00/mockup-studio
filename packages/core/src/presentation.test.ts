import { describe, expect, it } from 'vitest';
import { createNode } from './document.js';
import type { Node, Page } from './types.js';
import {
  clampSlideIndex,
  navigateSlide,
  presentationSlides,
  reconcileSlideIndex,
  slideIndexOfNode,
  startSlideIndex,
} from './presentation.js';

const frame = (id: string, name: string, children: Node[] = [], hidden = false): Node => ({
  ...createNode({ id, type: 'frame', tag: 'div', name, style: { width: '400px', height: '300px' } }),
  children,
  hidden,
});

const page = (frames: Node[]): Page => ({ id: 'pg_00000001', name: 'Page', frames, background: '' });

const deck = page([
  frame('fr_a', 'Intro', [createNode({ id: 'el_a1', tag: 'div', name: 'Box' })]),
  frame('fr_hidden', 'Draft', [], true),
  frame('fr_b', 'Agenda', [
    {
      ...createNode({ id: 'el_b1', tag: 'section', name: 'Section' }),
      children: [createNode({ id: 'tx_b2', type: 'text', tag: 'p', name: 'Text', text: 'Hi' })],
    },
  ]),
  frame('fr_c', 'Thanks'),
]);

describe('presentationSlides', () => {
  it('lists the visible root frames in page (Layers) order', () => {
    expect(presentationSlides(deck)).toEqual([
      { index: 0, id: 'fr_a', name: 'Intro' },
      { index: 1, id: 'fr_b', name: 'Agenda' },
      { index: 2, id: 'fr_c', name: 'Thanks' },
    ]);
  });

  it('is empty for a missing page or a page without visible frames', () => {
    expect(presentationSlides(null)).toEqual([]);
    expect(presentationSlides(page([]))).toEqual([]);
    expect(presentationSlides(page([frame('fr_x', 'X', [], true)]))).toEqual([]);
  });
});

describe('start slide resolution', () => {
  const slides = presentationSlides(deck);

  it('resolves a frame, a direct child and a deep descendant to its frame', () => {
    expect(slideIndexOfNode(deck, slides, 'fr_c')).toBe(2);
    expect(slideIndexOfNode(deck, slides, 'el_a1')).toBe(0);
    expect(slideIndexOfNode(deck, slides, 'tx_b2')).toBe(1);
  });

  it('returns -1 for unknown nodes and hidden frames', () => {
    expect(slideIndexOfNode(deck, slides, 'el_nope')).toBe(-1);
    expect(slideIndexOfNode(deck, slides, 'fr_hidden')).toBe(-1);
    expect(slideIndexOfNode(null, slides, 'fr_a')).toBe(-1);
  });

  it('starts from the first selected node that is on a slide, otherwise from the first slide', () => {
    expect(startSlideIndex(deck, slides, ['tx_b2'])).toBe(1);
    expect(startSlideIndex(deck, slides, ['el_nope', 'fr_hidden', 'fr_c'])).toBe(2);
    expect(startSlideIndex(deck, slides, [])).toBe(0);
    expect(startSlideIndex(deck, slides)).toBe(0);
    expect(startSlideIndex(page([]), [], ['fr_a'])).toBe(-1);
  });
});

describe('navigateSlide', () => {
  it('moves forward and back, stopping at the edges', () => {
    expect(navigateSlide(0, 3, { type: 'next' })).toBe(1);
    expect(navigateSlide(2, 3, { type: 'next' })).toBe(2);
    expect(navigateSlide(1, 3, { type: 'previous' })).toBe(0);
    expect(navigateSlide(0, 3, { type: 'previous' })).toBe(0);
  });

  it('jumps to the first, the last or an index (clamped)', () => {
    expect(navigateSlide(1, 3, { type: 'first' })).toBe(0);
    expect(navigateSlide(0, 3, { type: 'last' })).toBe(2);
    expect(navigateSlide(0, 3, { type: 'goto', index: 1 })).toBe(1);
    expect(navigateSlide(0, 3, { type: 'goto', index: 99 })).toBe(2);
    expect(navigateSlide(2, 3, { type: 'goto', index: -4 })).toBe(0);
  });

  it('returns -1 with no slides', () => {
    expect(navigateSlide(0, 0, { type: 'next' })).toBe(-1);
    expect(clampSlideIndex(5, 0)).toBe(-1);
    expect(clampSlideIndex(Number.NaN, 4)).toBe(0);
    expect(clampSlideIndex(1.7, 4)).toBe(1);
  });
});

describe('reconcileSlideIndex (live updates)', () => {
  const s = (...ids: string[]) => ids.map((id, index) => ({ index, id, name: id }));

  it('keeps the current frame by id when slides are added or reordered', () => {
    expect(reconcileSlideIndex(s('a', 'b', 'c'), 1, s('new', 'a', 'b', 'c'))).toBe(2);
    expect(reconcileSlideIndex(s('a', 'b', 'c'), 2, s('c', 'a', 'b'))).toBe(0);
  });

  it('stays at the same position (clamped) when the current frame is removed', () => {
    expect(reconcileSlideIndex(s('a', 'b', 'c'), 1, s('a', 'c'))).toBe(1);
    expect(reconcileSlideIndex(s('a', 'b', 'c'), 2, s('a', 'b'))).toBe(1);
    expect(reconcileSlideIndex(s('a'), 0, s('x', 'y'))).toBe(0);
  });

  it('returns -1 when no slide is left and 0 when slides appear on an empty deck', () => {
    expect(reconcileSlideIndex(s('a', 'b'), 1, [])).toBe(-1);
    expect(reconcileSlideIndex([], -1, s('a'))).toBe(0);
  });
});
