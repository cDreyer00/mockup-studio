import { ArrowDown, ArrowLeftRight, ArrowRight, Expand, Square } from 'lucide-react';
import { useContext } from 'react';
import { IconButton, Row, Section } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import { MARGIN, PADDING } from './boxes';
import { BoxField } from './BoxField';
import {
  Body,
  LockedContext,
  SegButtons,
  StyleNum,
  StyleSelect,
  commitStyle,
  common,
} from './shared';
import type { NodeCtx } from './shared';

const DISPLAY: SelectOption[] = [
  'block',
  'flex',
  'inline-flex',
  'grid',
  'inline-block',
  'inline',
  'none',
].map((v) => ({ value: v, label: v }));
const WRAP: SelectOption[] = [
  { value: 'nowrap', label: 'Sem quebra' },
  { value: 'wrap', label: 'Quebra' },
  { value: 'wrap-reverse', label: 'Quebra inversa' },
];
const ALIGN: SelectOption[] = [
  { value: 'stretch', label: 'Esticar' },
  { value: 'flex-start', label: 'Início' },
  { value: 'center', label: 'Centro' },
  { value: 'flex-end', label: 'Fim' },
  { value: 'baseline', label: 'Linha de base' },
];
const JUSTIFY: SelectOption[] = [
  { value: 'flex-start', label: 'Início' },
  { value: 'center', label: 'Centro' },
  { value: 'flex-end', label: 'Fim' },
  { value: 'space-between', label: 'Entre' },
  { value: 'space-around', label: 'Ao redor' },
  { value: 'space-evenly', label: 'Uniforme' },
];
const OVERFLOW: SelectOption[] = ['visible', 'hidden', 'auto', 'scroll'].map((v) => ({
  value: v,
  label: v,
}));

export function LayoutSection({ ctxs }: { ctxs: readonly NodeCtx[] }) {
  const locked = useContext(LockedContext);
  const nodes = ctxs.map((c) => c.node);
  const flex = nodes.every((n) => n.style.display === 'flex' || n.style.display === 'inline-flex');
  const grid = nodes.every((n) => n.style.display === 'grid');
  const dir = common(nodes, (n) => n.style['flex-direction']) ?? 'row';
  const isColumn = typeof dir === 'string' && dir.startsWith('column');
  const isReverse = typeof dir === 'string' && dir.endsWith('reverse');
  const axisDir = (column: boolean, reverse: boolean) =>
    `${column ? 'column' : 'row'}${reverse ? '-reverse' : ''}`;

  return (
    <Section id="props-layout" title="Layout">
      <Body>
        <Row label="Display">
          <StyleSelect nodes={nodes} prop="display" options={DISPLAY} title="display" />
        </Row>
        {flex && (
          <>
            <Row label="Direção">
              <SegButtons
                value={dir === null ? null : isColumn ? 'column' : 'row'}
                options={[
                  { value: 'row', title: 'Linha', icon: <ArrowRight size={13} /> },
                  { value: 'column', title: 'Coluna', icon: <ArrowDown size={13} /> },
                ]}
                onChange={(v) =>
                  void commitStyle(
                    nodes,
                    'flex-direction',
                    v === '' ? '' : axisDir(v === 'column', isReverse),
                  )
                }
              />
              <IconButton
                title="Inverter direção"
                active={isReverse}
                disabled={locked}
                onClick={() =>
                  void commitStyle(nodes, 'flex-direction', axisDir(isColumn, !isReverse))
                }
              >
                <ArrowLeftRight size={13} />
              </IconButton>
            </Row>
            <Row label="Quebra">
              <StyleSelect nodes={nodes} prop="flex-wrap" options={WRAP} placeholder="Sem quebra" />
            </Row>
            <Row label="Alinhar">
              <StyleSelect
                nodes={nodes}
                prop="align-items"
                options={ALIGN}
                title="align-items"
                placeholder="Esticar"
              />
            </Row>
            <Row label="Distribuir">
              <StyleSelect
                nodes={nodes}
                prop="justify-content"
                options={JUSTIFY}
                title="justify-content"
                placeholder="Início"
              />
            </Row>
          </>
        )}
        {(flex || grid) && (
          <Row label="Gap">
            <StyleNum nodes={nodes} prop="gap" label="G" title="Espaçamento (gap)" min={0} />
          </Row>
        )}
        <Row label="Padding">
          <BoxField nodes={nodes} spec={PADDING} icon={<Square size={12} />} title="Padding" />
        </Row>
        <Row label="Margin">
          <BoxField nodes={nodes} spec={MARGIN} icon={<Expand size={12} />} title="Margin" />
        </Row>
        <Row label="Overflow">
          <StyleSelect
            nodes={nodes}
            prop="overflow"
            options={OVERFLOW}
            title="overflow"
            placeholder="visible"
          />
        </Row>
      </Body>
    </Section>
  );
}
