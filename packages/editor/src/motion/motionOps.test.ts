import { describe, expect, it } from 'vitest';
import { createNodeFromTag } from '@mockup/core';
import {
  addAnimationOp,
  changePresetPatch,
  defaultKind,
  formatMs,
  mergeAnimation,
  parseCustomKeyframes,
  parseMs,
  removeAnimationOp,
  snapMs,
  transitionToAllOp,
  updateAnimationOp,
} from './motionOps';

const node = (name: string, animations?: Parameters<typeof addAnimationOp>[1][]) => {
  const n = createNodeFromTag('div', { name });
  if (animations) n.animations = animations;
  return n;
};

describe('motionOps', () => {
  it('adds an animation to every node in one op, with a cascading delay', () => {
    const [a, b, c] = [node('a'), node('b', [{ kind: 'out', preset: 'fade' }]), node('c')];
    const op = addAnimationOp([a!, b!, c!], { kind: 'in', preset: 'fade-up', delay: 100 }, 50);
    expect(op.changes).toEqual([
      { nodeId: a!.id, animations: [{ kind: 'in', preset: 'fade-up', delay: 100 }] },
      {
        nodeId: b!.id,
        animations: [
          { kind: 'out', preset: 'fade' },
          { kind: 'in', preset: 'fade-up', delay: 150 },
        ],
      },
      { nodeId: c!.id, animations: [{ kind: 'in', preset: 'fade-up', delay: 200 }] },
    ]);
  });

  it('without cascade nor delay the delay field is omitted', () => {
    const a = node('a');
    const op = addAnimationOp([a], { kind: 'in', preset: 'fade' });
    expect(op.changes[0]!.animations).toEqual([{ kind: 'in', preset: 'fade' }]);
  });

  it('update merges the patch and drops undefined fields', () => {
    const a = node('a', [
      { kind: 'in', preset: 'fade', delay: 100, duration: 300 },
      { kind: 'emphasis', preset: 'pulse' },
    ]);
    const op = updateAnimationOp(a, 0, { delay: 200, duration: undefined })!;
    expect(op.changes[0]!.animations).toEqual([
      { kind: 'in', preset: 'fade', delay: 200 },
      { kind: 'emphasis', preset: 'pulse' },
    ]);
    expect(updateAnimationOp(a, 5, { delay: 1 })).toBeNull();
    expect(mergeAnimation({ kind: 'in', preset: 'fade' }, { build: 1 })).toEqual({
      kind: 'in',
      preset: 'fade',
      build: 1,
    });
  });

  it('remove drops one animation and clears the list with the last one', () => {
    const a = node('a', [
      { kind: 'in', preset: 'fade' },
      { kind: 'out', preset: 'fade' },
    ]);
    expect(removeAnimationOp(a, 0)!.changes[0]!.animations).toEqual([
      { kind: 'out', preset: 'fade' },
    ]);
    const one = node('b', [{ kind: 'in', preset: 'fade' }]);
    expect(removeAnimationOp(one, 0)!.changes[0]!.animations).toBeNull();
    expect(removeAnimationOp(one, 3)).toBeNull();
  });

  it('applies the transition to all the frames of the page', () => {
    const f1 = node('f1');
    const f2 = node('f2');
    const op = transitionToAllOp({ frames: [f1, f2] }, { preset: 'push', direction: 'up' });
    expect(op.changes).toEqual([
      { nodeId: f1.id, transition: { preset: 'push', direction: 'up' } },
      { nodeId: f2.id, transition: { preset: 'push', direction: 'up' } },
    ]);
  });

  it('changing the preset resets params and picks a supported kind', () => {
    const patch = changePresetPatch(
      { kind: 'in', preset: 'fade-up', params: { distance: 10 }, duration: 100 },
      'pulse',
    );
    expect(
      mergeAnimation({ kind: 'in', preset: 'fade-up', params: { distance: 10 } }, patch),
    ).toEqual({ kind: defaultKind('pulse', 'in'), preset: 'pulse' });
  });

  it('validates custom keyframes with the core', () => {
    const anim = { kind: 'in' as const, preset: 'custom' };
    expect('error' in parseCustomKeyframes(anim, '{nope')).toBe(true);
    expect('error' in parseCustomKeyframes(anim, '{}')).toBe(true);
    const ok = parseCustomKeyframes(anim, '[{"opacity":0},{"opacity":1}]');
    expect('animation' in ok && ok.animation.keyframes).toHaveLength(2);
  });

  it('snaps and parses times', () => {
    expect(snapMs(123)).toBe(120);
    expect(snapMs(149, 100)).toBe(100);
    expect(parseMs('250')).toBe(250);
    expect(parseMs('0.5s')).toBe(500);
    expect(parseMs('abc')).toBeNull();
    expect(formatMs(1500)).toBe('1.5 s');
    expect(formatMs(80)).toBe('80 ms');
  });
});
