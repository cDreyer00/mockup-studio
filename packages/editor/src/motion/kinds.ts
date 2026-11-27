/** Labels shared by the Animation section, the preset picker and the timeline. */
import { MAX_BUILD } from '@mockup/core';
import type { AnimationKind, MotionTimeline } from '@mockup/core';

export const KIND_LABELS: Record<AnimationKind, string> = {
  in: 'In',
  out: 'Out',
  emphasis: 'Emphasis',
};

/** Badge class + label: infinite emphasis animations are shown as "Loop". */
export function kindBadge(
  kind: AnimationKind,
  iterations: number | 'infinite' | undefined,
): { cls: string; label: string } {
  if (kind === 'emphasis' && iterations === 'infinite') return { cls: 'mo-loop', label: 'Loop' };
  return { cls: `mo-${kind}`, label: KIND_LABELS[kind] };
}

/** Label of a build by its CLICK (play order), not its number: builds 0, 2, 5 read On start, Click 1, Click 2. */
export const buildLabel = (click: number | undefined): string =>
  click ? `Click ${click}` : 'On start';

/** Click (play order) of a build number in a timeline; the number itself when it is not there. */
export function clickOfBuild(timeline: MotionTimeline | null, build: number): number {
  return timeline?.builds.find((b) => b.build === build)?.click ?? build;
}

/**
 * Choices of the "Start" field: the frame's builds in play order, then a new click after the last
 * one. Sparse build numbers keep their value but read by click, so no choice lands in between.
 */
export function buildChoices(
  timeline: MotionTimeline | null,
  current: number,
): { value: number; label: string }[] {
  const builds = timeline?.builds ?? [{ build: 0, click: 0 }];
  const out = builds.map((b) => ({
    value: b.build,
    label: b.click === 0 ? 'On slide start' : `Click ${b.click}`,
  }));
  const last = builds[builds.length - 1]!.build;
  if (last < MAX_BUILD) out.push({ value: last + 1, label: `Click ${builds.length}` });
  // an animation the timeline skips (hidden node): keep its value selectable
  if (!out.some((o) => o.value === current)) {
    out.push({ value: current, label: `Build ${current}` });
    out.sort((a, b) => a.value - b.value);
  }
  return out;
}
