/** `<optgroup>` list of the named easings (shared by the animation and transition selects). */
import type { ReactNode } from 'react';
import { NAMED_EASINGS } from '@mockup/core';

const GROUPS: { label: string; group: string }[] = [
  { label: 'Basic', group: 'basic' },
  { label: 'Smooth', group: 'smooth' },
  { label: 'Overshoot', group: 'overshoot' },
  { label: 'Physics', group: 'physics' },
];

export function EasingOptions({ extra }: { extra?: ReactNode }) {
  return (
    <>
      {GROUPS.map((g) => (
        <optgroup key={g.group} label={g.label}>
          {NAMED_EASINGS.filter((e) => e.group === g.group).map((e) => (
            <option key={e.name} value={e.name} title={e.description}>
              {e.label}
            </option>
          ))}
        </optgroup>
      ))}
      {extra}
    </>
  );
}
