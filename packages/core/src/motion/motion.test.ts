/**
 * Motion engine: presets compile to sound keyframes, easings, normalization, text/children
 * splitting, the frame timeline and slide transitions.
 */
import { describe, expect, it } from 'vitest';
import { createNodeFromTag } from '../document.js';
import type { Node, NodeAnimation } from '../types.js';
import { compileAnimation, compileNodeMotion, motionBaseOf } from './compile.js';
import { easingProblem, resolveEasing } from './easing.js';
import { normalizeAnimation, normalizeTransition } from './normalize.js';
import { MOTION_PRESETS } from './presets.js';
import { transitionPlan } from './transitions.js';
import { buildTimesAt, frameMotionTimeline, linearTimeAt } from './timeline.js';

function animated(
  animations: NodeAnimation[],
  opts: { style?: Record<string, string>; text?: string; children?: Node[] } = {},
): Node {
  const node = createNodeFromTag('div', {
    styles: opts.style ?? {},
    text: opts.text,
    children: opts.children,
  });
  node.animations = animations;
  return node;
}

function frameWith(nodes: Node[]): Node {
  return createNodeFromTag('div', { isRoot: true, children: nodes });
}

const hidden = (k: Record<string, unknown>): boolean =>
  k.opacity === '0' || String(k['clip-path'] ?? '').includes('100%');

describe('presets', () => {
  const cases = MOTION_PRESETS.filter((p) => p.name !== 'custom').flatMap((p) =>
    p.kinds.map((kind) => [p.name, kind] as const),
  );

  it.each(cases)('%s as %s compiles to clean keyframes', (preset, kind) => {
    const { keyframes } = compileAnimation({ kind, preset });
    expect(keyframes.length).toBeGreaterThanOrEqual(2);
    for (const k of keyframes) {
      for (const v of Object.values(k)) {
        expect(v).not.toBeUndefined();
        expect(String(v)).not.toMatch(/NaN|undefined/);
      }
    }
    const first = keyframes[0]!;
    const last = keyframes[keyframes.length - 1]!;
    if (kind === 'in') expect(hidden(first)).toBe(true);
    if (kind === 'out') expect(hidden(last)).toBe(true);
    if (kind === 'emphasis') expect(first).not.toHaveProperty('transform');
  });

  it('entrances end at the own opacity and transform of the node', () => {
    const base = motionBaseOf({ opacity: '0.5', transform: 'rotate(5deg)' });
    const { keyframes } = compileAnimation({ kind: 'in', preset: 'fade-up' }, base);
    const last = keyframes[keyframes.length - 1]!;
    expect(keyframes[0]!.opacity).toBe('0');
    expect(last.opacity).toBe('0.5');
    expect(String(last.transform)).toMatch(/rotate\(5deg\)$/);
  });

  it('exits mirror entrances: start at rest, end hidden', () => {
    const base = motionBaseOf({ opacity: '0.5', transform: 'rotate(5deg)' });
    const { keyframes } = compileAnimation({ kind: 'out', preset: 'fade-up' }, base);
    expect(keyframes[0]!.opacity).toBe('0.5');
    expect(String(keyframes[0]!.transform)).toMatch(/rotate\(5deg\)$/);
    expect(keyframes[keyframes.length - 1]!.opacity).toBe('0');
  });

  it('wipes start clipped from one side', () => {
    const { keyframes } = compileAnimation({ kind: 'in', preset: 'wipe-right' });
    expect(String(keyframes[0]!['clip-path'])).toContain('100%');
  });

  it('emphasis composes with a base translate through calc()', () => {
    const base = motionBaseOf({ translate: '-50% 0' });
    const { keyframes } = compileAnimation({ kind: 'emphasis', preset: 'float' }, base);
    const moved = keyframes.map((k) => String(k.translate));
    expect(moved.every((v) => v.startsWith('calc(-50% + '))).toBe(true);
    expect(moved.join(' ')).not.toContain('calc(0 +');
    const spin = compileAnimation({ kind: 'emphasis', preset: 'spin' }).keyframes;
    expect(spin.some((k) => 'rotate' in k)).toBe(true);
    const pulse = compileAnimation({ kind: 'emphasis', preset: 'pulse' }).keyframes;
    expect(pulse.some((k) => 'scale' in k)).toBe(true);
  });

  it('fill rules: in backwards, out forwards, emphasis none', () => {
    expect(compileAnimation({ kind: 'in', preset: 'fade' }).timing.fill).toBe('backwards');
    expect(compileAnimation({ kind: 'out', preset: 'fade' }).timing.fill).toBe('forwards');
    expect(compileAnimation({ kind: 'emphasis', preset: 'pulse' }).timing.fill).toBe('none');
  });
});

describe('easing', () => {
  it('springs become linear() and named easings cubic-bezier', () => {
    const spring = resolveEasing('spring');
    expect(spring.startsWith('linear(0')).toBe(true);
    expect(spring.endsWith(', 1)')).toBe(true);
    expect(resolveEasing('back-out')).toMatch(/^cubic-bezier\(/);
  });

  it('rejects unknown easings', () => {
    expect(easingProblem('wobbly')).toEqual(expect.any(String));
    expect(easingProblem('ease-in-out')).toBeNull();
    expect(easingProblem('spring')).toBeNull();
  });
});

describe('normalizeAnimation', () => {
  it('strips defaults', () => {
    expect(
      normalizeAnimation({ kind: 'in', preset: 'fade-up', duration: 600, delay: 0, build: 0 }),
    ).toEqual({ kind: 'in', preset: 'fade-up' });
  });

  it('keeps non-default values', () => {
    const a = normalizeAnimation({ kind: 'in', preset: 'fade-up', duration: 900, build: 2 });
    expect(a).toEqual({ kind: 'in', preset: 'fade-up', duration: 900, build: 2 });
  });

  it('rejects unknown presets, params and kinds listing the valid values', () => {
    expect(() => normalizeAnimation({ kind: 'in', preset: 'nope' })).toThrow(/Presets: fade/);
    expect(() => normalizeAnimation({ kind: 'in', preset: 'fade-up', params: { x: 1 } })).toThrow(
      /params: distance/,
    );
    expect(() => normalizeAnimation({ kind: 'zzz', preset: 'fade-up' })).toThrow(
      /"in", "out" or "emphasis"/,
    );
  });

  it('rejects stagger without split, keyframes on presets and out-of-range values', () => {
    expect(() => normalizeAnimation({ kind: 'in', preset: 'fade', stagger: 10 })).toThrow(/split/);
    expect(() =>
      normalizeAnimation({ kind: 'in', preset: 'fade', keyframes: [{ opacity: '0' }] }),
    ).toThrow(/only applies to preset "custom"/);
    expect(() => normalizeAnimation({ kind: 'in', preset: 'fade', duration: -1 })).toThrow(
      /between/,
    );
    expect(() => normalizeAnimation({ kind: 'in', preset: 'fade', duration: 1e9 })).toThrow(
      /between/,
    );
  });

  it('kebab-cases custom keyframes and rejects unsafe values', () => {
    const a = normalizeAnimation({
      kind: 'in',
      preset: 'custom',
      keyframes: [{ backgroundColor: 'red', offset: 0 }, { opacity: '1' }],
    });
    expect(a.keyframes![0]).toHaveProperty('background-color', 'red');
    for (const bad of ['0; color: red', '0 } body {']) {
      expect(() =>
        normalizeAnimation({
          kind: 'in',
          preset: 'custom',
          keyframes: [{ opacity: bad }, { opacity: '1' }],
        }),
      ).toThrow();
    }
  });
});

describe('splitting', () => {
  it('children: one entry per visible child, delayed by i * stagger', () => {
    const kids = [1, 2, 3, 4].map(() => createNodeFromTag('div'));
    kids[2]!.hidden = true;
    const node = animated([{ kind: 'in', preset: 'fade-up', split: 'children', stagger: 100 }], {
      children: kids,
    });
    const out = compileNodeMotion(node);
    expect(out.map((c) => c.target)).toEqual([
      { type: 'child', index: 0 },
      { type: 'child', index: 1 },
      { type: 'child', index: 2 },
    ]);
    expect(out.map((c) => c.timing.delay)).toEqual([0, 100, 200]);
  });

  it('chars: one entry per character, spaces not counted', () => {
    const node = animated([{ kind: 'in', preset: 'fade', split: 'chars' }], { text: 'ab cd' });
    const out = compileNodeMotion(node);
    expect(out).toHaveLength(4);
    expect(out.map((c) => c.timing.delay)).toEqual([0, 30, 60, 90]);
  });
});

describe('frameMotionTimeline', () => {
  const a = animated([{ kind: 'in', preset: 'fade', duration: 500 }]);
  const b = animated([{ kind: 'in', preset: 'fade-up', duration: 400, delay: 100, build: 1 }]);
  const c = animated([{ kind: 'out', preset: 'fade', duration: 300, build: 2 }]);
  const loop = animated([{ kind: 'emphasis', preset: 'pulse', iterations: 'infinite' }]);

  it('orders builds with build 0 first, linear starts back to back, loops excluded', () => {
    const t = frameMotionTimeline(frameWith([c, b, loop, a]));
    expect(t.builds.map((x) => x.build)).toEqual([0, 1, 2]);
    expect(t.builds.map((x) => x.start)).toEqual([0, 500, 1000]);
    expect(t.builds[1]!.duration).toBe(500);
    expect(t.duration).toBe(1300);
    expect(t.clicks).toBe(2);
    expect(t.loops).toBe(1);
  });

  it('counts distinct builds greater than 0 as clicks', () => {
    const same = animated([{ kind: 'in', preset: 'fade', build: 1 }]);
    const t = frameMotionTimeline(frameWith([b, same]));
    expect(t.clicks).toBe(1);
    expect(frameMotionTimeline(frameWith([a])).builds).toHaveLength(1);
  });

  it('warns about two entrances and an exit before the entrance', () => {
    const twice = animated([
      { kind: 'in', preset: 'fade' },
      { kind: 'in', preset: 'zoom-in', build: 1 },
    ]);
    const early = animated([
      { kind: 'out', preset: 'fade', build: 1 },
      { kind: 'in', preset: 'fade', build: 2 },
    ]);
    const t = frameMotionTimeline(frameWith([twice, early]));
    expect(t.warnings.some((w) => w.includes('2 entrances'))).toBe(true);
    expect(t.warnings.some((w) => w.includes('before it enters'))).toBe(true);
  });

  it('buildTimesAt and linearTimeAt', () => {
    const t = frameMotionTimeline(frameWith([b, a]));
    expect([...buildTimesAt(t, { time: 600 })]).toEqual([
      [0, 600],
      [1, 100],
    ]);
    expect([...buildTimesAt(t, { build: 1 })]).toEqual([
      [0, 500],
      [1, 500],
    ]);
    expect([...buildTimesAt(t, { build: 1, time: 50 })]).toEqual([
      [0, 500],
      [1, 50],
    ]);
    expect([...buildTimesAt(t, { build: 0, time: 50 })]).toEqual([
      [0, 50],
      [1, 0],
    ]);
    expect(linearTimeAt(t, { time: 123 })).toBe(123);
    expect(linearTimeAt(t, { build: 1, time: 50 })).toBe(550);
    expect(linearTimeAt(t, { build: 1 })).toBe(1000);
  });
});

describe('slide transitions', () => {
  it('normalizes and rejects a direction on fade', () => {
    expect(normalizeTransition({ preset: 'push', direction: 'left' })).toEqual({ preset: 'push' });
    expect(normalizeTransition({ preset: 'push', direction: 'up' })).toEqual({
      preset: 'push',
      direction: 'up',
    });
    expect(() => normalizeTransition({ preset: 'fade', direction: 'left' })).toThrow(
      /no direction/,
    );
    expect(() => normalizeTransition({ preset: 'nope' })).toThrow(/Transitions:/);
  });

  it('reverse swaps the roles of the slides', () => {
    const fwd = transitionPlan({ preset: 'push', direction: 'left' })!;
    const rev = transitionPlan({ preset: 'push', direction: 'left' }, true)!;
    expect(fwd.incoming.reverse).toBe(false);
    expect(rev.outgoing.reverse).toBe(true);
    expect(rev.outgoing.keyframes).toEqual(fwd.incoming.keyframes);
    expect(rev.incoming.keyframes).toEqual(fwd.outgoing.keyframes);
  });
});
