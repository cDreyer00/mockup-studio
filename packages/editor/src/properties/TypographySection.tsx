import { useContext, useEffect, useState } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  MoveHorizontal,
  MoveVertical,
} from 'lucide-react';
import type { Node } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { Row, Section } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import {
  Body,
  DraftInput,
  LockedContext,
  StyleColor,
  StyleNum,
  StyleSelect,
  StyleSeg,
  commitStyle,
  common,
  runOps,
  styleOf,
} from './shared';

const TEXT_TAGS = new Set([
  'p',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'button',
  'label',
  'li',
  'strong',
  'em',
  'small',
  'blockquote',
  'code',
  'pre',
]);

export const isTextual = (n: Node): boolean => n.type === 'text' || TEXT_TAGS.has(n.tag);

const COMMON_FONTS = [
  'Inter',
  'system-ui',
  'Arial',
  'Helvetica',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Roboto',
  'Open Sans',
  'Montserrat',
  'Poppins',
  'Lato',
  'JetBrains Mono',
  'monospace',
  'sans-serif',
  'serif',
];

const WEIGHTS: SelectOption[] = [
  [100, 'Thin'],
  [200, 'Extra Light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semi Bold'],
  [700, 'Bold'],
  [800, 'Extra Bold'],
  [900, 'Black'],
].map(([w, name]) => ({ value: String(w), label: `${w} ${name}` }));

const DECORATION: SelectOption[] = [
  { value: 'none', label: 'Nenhuma' },
  { value: 'underline', label: 'Sublinhado' },
  { value: 'line-through', label: 'Tachado' },
];
const TRANSFORM: SelectOption[] = [
  { value: 'none', label: 'Nenhuma' },
  { value: 'uppercase', label: 'MAIÚSCULAS' },
  { value: 'lowercase', label: 'minúsculas' },
  { value: 'capitalize', label: 'Capitalizar' },
];

function TextContent({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const shown = common(nodes, (n) => n.text) ?? '';
  const mixed = common(nodes, (n) => n.text) === null;
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  const commit = () => {
    if (text === shown) return;
    void runOps([{ type: 'setText', changes: nodes.map((n) => ({ nodeId: n.id, text })) }]);
  };
  return (
    <textarea
      className="prop-textarea"
      data-testid="prop-text"
      value={text}
      rows={3}
      disabled={locked}
      placeholder={mixed ? 'Misto' : 'Texto'}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
        e.stopPropagation();
      }}
    />
  );
}

export function TypographySection({ nodes }: { nodes: readonly Node[] }) {
  const docFonts = useDoc((s) => s.doc?.fonts);
  const textual = nodes.every(isTextual);
  const allText = nodes.every((n) => n.type === 'text');
  const families = [...new Set([...(docFonts?.map((f) => f.family) ?? []), ...COMMON_FONTS])];
  return (
    <Section key={String(textual)} id="props-type" title="Tipografia" defaultOpen={textual}>
      <Body>
        {allText && <TextContent nodes={nodes} />}
        <Row label="Fonte">
          <DraftInput
            value={common(nodes, styleOf('font-family'))}
            list="prop-font-list"
            placeholder="herdada"
            title="font-family"
            onCommit={(v) => void commitStyle(nodes, 'font-family', v)}
          />
          <datalist id="prop-font-list">
            {families.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Row>
        <Row label="Peso">
          <StyleSelect nodes={nodes} prop="font-weight" options={WEIGHTS} title="font-weight" />
        </Row>
        <div className="prop-row-2">
          <StyleNum nodes={nodes} prop="font-size" label="Aa" title="Tamanho da fonte" min={0} />
          <StyleNum
            nodes={nodes}
            prop="line-height"
            label={<MoveVertical size={12} />}
            title="Altura da linha (1.4 ou 24px)"
            unit=""
            min={0}
            step={0.1}
          />
        </div>
        <div className="prop-row-2">
          <StyleNum
            nodes={nodes}
            prop="letter-spacing"
            label={<MoveHorizontal size={12} />}
            title="Espaçamento entre letras"
            step={0.1}
          />
          <StyleSelect
            nodes={nodes}
            prop="text-transform"
            options={TRANSFORM}
            title="text-transform"
            placeholder="Caixa"
          />
        </div>
        <Row label="Alinhar">
          <StyleSeg
            nodes={nodes}
            prop="text-align"
            options={[
              { value: 'left', title: 'Esquerda', icon: <AlignLeft size={13} /> },
              { value: 'center', title: 'Centro', icon: <AlignCenter size={13} /> },
              { value: 'right', title: 'Direita', icon: <AlignRight size={13} /> },
              { value: 'justify', title: 'Justificado', icon: <AlignJustify size={13} /> },
            ]}
          />
        </Row>
        <Row label="Cor">
          <StyleColor nodes={nodes} prop="color" title="Cor do texto" />
        </Row>
        <Row label="Decoração">
          <StyleSelect
            nodes={nodes}
            prop="text-decoration"
            options={DECORATION}
            title="text-decoration"
          />
        </Row>
      </Body>
    </Section>
  );
}
