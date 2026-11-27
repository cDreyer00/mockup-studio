import { describe, expect, it } from 'vitest';
import { frameMotionTimeline } from '@mockup/core';
import type { Node, NodeAnimation } from '@mockup/core';
import { buildChoices, buildLabel, clickOfBuild } from './kinds';

const frameWith = (animations: NodeAnimation[]): Node => {
  const child: Node = {
    id: 'el_a',
    type: 'element',
    name: 'A',
    tag: 'div',
    attrs: {},
    style: {},
    children: [],
    locked: false,
    hidden: false,
    animations,
  };
  return { ...child, id: 'fr_k', type: 'frame', animations: undefined, children: [child] };
};

describe('build choices', () => {
  it('dense builds: one choice per build plus the next click', () => {
    const tl = frameMotionTimeline(frameWith([{ kind: 'in', preset: 'fade', build: 1 }]));
    expect(buildChoices(tl, 1)).toEqual([
      { value: 0, label: 'On slide start' },
      { value: 1, label: 'Click 1' },
      { value: 2, label: 'Click 2' },
    ]);
  });

  it('sparse builds read by click and nothing lands in between', () => {
    const tl = frameMotionTimeline(
      frameWith([
        { kind: 'in', preset: 'fade', build: 2 },
        { kind: 'emphasis', preset: 'pulse', build: 5 },
      ]),
    );
    expect(buildChoices(tl, 5)).toEqual([
      { value: 0, label: 'On slide start' },
      { value: 2, label: 'Click 1' },
      { value: 5, label: 'Click 2' },
      { value: 6, label: 'Click 3' },
    ]);
    expect(buildLabel(clickOfBuild(tl, 5))).toBe('Click 2');
    expect(buildLabel(clickOfBuild(tl, 0))).toBe('On start');
  });

  it('keeps a build the timeline does not know (no frame, hidden node)', () => {
    expect(buildChoices(null, 3)).toEqual([
      { value: 0, label: 'On slide start' },
      { value: 1, label: 'Click 1' },
      { value: 3, label: 'Build 3' },
    ]);
  });
});
