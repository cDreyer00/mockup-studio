/** Labels shared by the Animation section, the preset picker and the timeline. */
import type { AnimationKind } from '@mockup/core';

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

export const buildLabel = (build: number | undefined): string =>
  build ? `Click ${build}` : 'On start';
