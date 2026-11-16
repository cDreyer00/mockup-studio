/** Lista editável de sombras (`box-shadow` com várias camadas). */
import { useContext } from 'react';
import { Plus, X } from 'lucide-react';
import type { Node } from '@mockup/core';
import { ColorInput, IconButton } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { parseShadows, serializeShadows, splitTopLevel } from './css';
import type { Shadow } from './css';
import { DraftInput, LockedContext, commitStyle, common, styleOf } from './shared';

const NEW_SHADOW: Shadow = {
  x: '0px',
  y: '4px',
  blur: '12px',
  spread: '',
  color: 'rgba(0, 0, 0, 0.25)',
  inset: false,
};

export function ShadowList({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const value = common(nodes, styleOf('box-shadow'));
  const raw = value ?? '';
  const list = parseShadows(raw);
  const valid =
    raw.trim() === '' || raw.trim() === 'none' || list.length === splitTopLevel(raw, ',').length;
  const write = (next: Shadow[]) => void commitStyle(nodes, 'box-shadow', serializeShadows(next));

  if (value === null || !valid) {
    return (
      <div className="prop-shadows">
        <DraftInput
          value={value}
          mono
          placeholder="box-shadow"
          onCommit={(v) => void commitStyle(nodes, 'box-shadow', v)}
        />
        <IconButton
          title="Substituir por uma sombra"
          disabled={locked}
          onClick={() => write([NEW_SHADOW])}
        >
          <Plus size={13} />
        </IconButton>
      </div>
    );
  }

  const update = (i: number, patch: Partial<Shadow>) =>
    write(list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div className="prop-shadows">
      {list.map((s, i) => (
        <div className="prop-shadow" key={i}>
          <div className="prop-grid-4">
            <NumberInput
              label="X"
              title="Deslocamento X"
              value={s.x}
              disabled={locked}
              onCommit={(v) => update(i, { x: v || '0px' })}
            />
            <NumberInput
              label="Y"
              title="Deslocamento Y"
              value={s.y}
              disabled={locked}
              onCommit={(v) => update(i, { y: v || '0px' })}
            />
            <NumberInput
              label="B"
              title="Desfoque"
              value={s.blur}
              min={0}
              disabled={locked}
              onCommit={(v) => update(i, { blur: v })}
            />
            <NumberInput
              label="S"
              title="Espalhamento"
              value={s.spread}
              disabled={locked}
              onCommit={(v) => update(i, { spread: v })}
            />
          </div>
          <div className="prop-row-shadow">
            <ColorInput value={s.color} onCommit={(v) => update(i, { color: v })} />
            <IconButton
              title="Sombra interna"
              active={s.inset}
              disabled={locked}
              onClick={() => update(i, { inset: !s.inset })}
            >
              <span className="prop-tiny">in</span>
            </IconButton>
            <IconButton
              title="Remover sombra"
              disabled={locked}
              onClick={() => write(list.filter((_, j) => j !== i))}
            >
              <X size={12} />
            </IconButton>
          </div>
        </div>
      ))}
      <IconButton
        title="Adicionar sombra"
        disabled={locked}
        className="prop-add"
        onClick={() => write([...list, NEW_SHADOW])}
      >
        <Plus size={13} />
      </IconButton>
    </div>
  );
}
