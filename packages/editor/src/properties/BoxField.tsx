/** Campo de 4 lados vinculados (padding, margin, border-radius) com opção de expandir. */
import { useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { Node } from '@mockup/core';
import { IconButton } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { normalizeInput } from '../ui/units';
import { readBox, uniformBox, writeBox } from './boxes';
import type { BoxSpec } from './boxes';
import { parseBox, serializeBox } from './css';
import type { Box } from './css';
import { commitStyles, common, LockedContext, previewStyles } from './shared';
import { BoundNumberInput } from './TokenBinding';

const SIDE_LABELS = ['T', 'R', 'B', 'L'];
const SIDE_KEYS = ['top', 'right', 'bottom', 'left'] as const;
const SIDE_TITLES: Record<string, string[]> = {
  padding: ['Topo', 'Direita', 'Base', 'Esquerda'],
  margin: ['Topo', 'Direita', 'Base', 'Esquerda'],
  'border-radius': ['Sup. esq.', 'Sup. dir.', 'Inf. dir.', 'Inf. esq.'],
};

export function BoxField({
  nodes,
  spec,
  icon,
  title,
}: {
  nodes: readonly Node[];
  spec: BoxSpec;
  icon: ReactNode;
  title: string;
}) {
  const locked = useContext(LockedContext);
  const [expanded, setExpanded] = useState(false);
  const boxes = nodes.map((n) => readBox(n.style, spec));
  const linked = common(boxes, (b) => {
    const s = serializeBox({
      top: b.top,
      right: b.right,
      bottom: b.bottom,
      left: b.left,
    });
    return s === '' ? undefined : s;
  });

  const apply = (fn: (box: Box) => Box) =>
    void commitStyles(nodes, (n) => writeBox(n.style, spec, fn(readBox(n.style, spec))));

  const onLinked = (text: string) => {
    const t = text.trim();
    if (t === '') return apply(() => uniformBox(''));
    const norm = t
      .split(/\s+/)
      .map((p) => normalizeInput(p))
      .join(' ');
    const box = parseBox(norm);
    if (box) apply(() => box);
  };

  return (
    <div className="prop-box">
      <div className="prop-row-2">
        <BoundNumberInput
          bind={{ nodes, prop: spec.prop, value: common(nodes, (n) => n.style[spec.prop]) }}
          label={icon}
          title={title}
          value={linked}
          disabled={locked}
          min={spec.prop === 'padding' || spec.prop === 'border-radius' ? 0 : undefined}
          onPreview={(v) => previewStyles(nodes, () => ({ [spec.prop]: v }))}
          onCommit={onLinked}
        />
        <IconButton
          title={expanded ? 'Lados vinculados' : 'Editar cada lado'}
          active={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </IconButton>
      </div>
      {expanded && (
        <div className="prop-grid-2">
          {SIDE_KEYS.map((k, i) => (
            <NumberInput
              key={k}
              label={SIDE_LABELS[i]}
              title={SIDE_TITLES[spec.prop]![i]}
              value={common(boxes, (b) => b[k] || undefined)}
              disabled={locked}
              onCommit={(v) => apply((b) => ({ ...b, [k]: v }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
