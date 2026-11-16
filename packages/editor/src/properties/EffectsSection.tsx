import { useContext } from 'react';
import type { Node } from '@mockup/core';
import { Row, Section } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { getFilterFn, setFilterFn } from './css';
import {
  Body,
  DraftInput,
  LockedContext,
  commitStyle,
  commitStyles,
  common,
  previewStyles,
} from './shared';

function BlurField({
  nodes,
  prop,
  title,
}: {
  nodes: readonly Node[];
  prop: 'filter' | 'backdrop-filter';
  title: string;
}) {
  const locked = useContext(LockedContext);
  const value = common(nodes, (n) => getFilterFn(n.style[prop], 'blur') ?? undefined);
  return (
    <NumberInput
      label="B"
      title={title}
      min={0}
      value={value}
      placeholder="0px"
      disabled={locked}
      onPreview={(v) =>
        previewStyles(nodes, (n) => ({ [prop]: setFilterFn(n.style[prop], 'blur', v) }))
      }
      onCommit={(v) =>
        void commitStyles(nodes, (n) => {
          const next = setFilterFn(n.style[prop], 'blur', v);
          return next ? { set: { [prop]: next } } : { unset: [prop] };
        })
      }
    />
  );
}

export function EffectsSection({ nodes }: { nodes: readonly Node[] }) {
  return (
    <Section id="props-effects" title="Efeitos" defaultOpen={false}>
      <Body>
        <Row label="Blur">
          <BlurField nodes={nodes} prop="filter" title="Desfoque (filter: blur)" />
        </Row>
        <Row label="Blur fundo">
          <BlurField
            nodes={nodes}
            prop="backdrop-filter"
            title="Desfoque do fundo (backdrop-filter: blur)"
          />
        </Row>
        <Row label="filter">
          <DraftInput
            value={common(nodes, (n) => n.style.filter)}
            mono
            placeholder="nenhum"
            onCommit={(v) => void commitStyle(nodes, 'filter', v)}
          />
        </Row>
        <Row label="backdrop">
          <DraftInput
            value={common(nodes, (n) => n.style['backdrop-filter'])}
            mono
            placeholder="nenhum"
            onCommit={(v) => void commitStyle(nodes, 'backdrop-filter', v)}
          />
        </Row>
      </Body>
    </Section>
  );
}
