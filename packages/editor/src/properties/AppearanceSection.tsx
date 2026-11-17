import { useContext } from 'react';
import { Blend, PaintBucket, Palette } from 'lucide-react';
import type { Node } from '@mockup/core';
import { ColorInput, IconButton, Row, SelectInput, Section } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { parseCssNumber } from '../ui/units';
import { BoxField } from './BoxField';
import { RADIUS } from './boxes';
import { parseBorder, serializeBorder } from './css';
import type { Border } from './css';
import { varRefName } from '../tokens/tokensLogic';
import { ShadowList } from './ShadowList';
import { TokenBound } from './TokenBinding';
import {
  Body,
  DraftInput,
  LockedContext,
  StyleSelect,
  commitStyles,
  common,
  previewStyles,
} from './shared';

const BLEND: SelectOption[] = [
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
].map((v) => ({ value: v, label: v }));
const BORDER_STYLE: SelectOption[] = ['solid', 'dashed', 'dotted', 'none'].map((v) => ({
  value: v,
  label: v,
}));

const DEFAULT_GRADIENT = 'linear-gradient(180deg, #2dd4bf 0%, #6366f1 100%)';
const isComplexBg = (v: string): boolean =>
  /^(linear-|radial-|conic-|repeating-)?gradient|^url\(|^var\(|gradient\(/i.test(v.trim());

/** Valor do fundo: `background` ou, se ausente, `background-color`. */
const bgOf = (n: Node): string | undefined => n.style.background ?? n.style['background-color'];

function Background({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const value = common(nodes, bgOf);
  const complex = typeof value === 'string' && isComplexBg(value);
  const write = (v: string) =>
    void commitStyles(nodes, (n) => {
      const unset = 'background-color' in n.style ? ['background-color'] : [];
      if (v.trim() === '') return { unset: ['background', ...unset].filter((k) => k in n.style) };
      return { set: { background: v.trim() }, unset };
    });
  const toggle = () => {
    if (complex) {
      const hex = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i.exec(value)?.[0];
      write(hex ?? '#ffffff');
    } else write(DEFAULT_GRADIENT);
  };
  const isVar = varRefName(typeof value === 'string' ? value : null) !== null;
  return (
    <div className="prop-bg">
      <TokenBound nodes={nodes} prop="background" kind="color" value={value} write={write}>
        {complex || value === null ? (
          <DraftInput
            value={value}
            mono
            placeholder="gradiente, url(...) ou var(...)"
            onCommit={write}
          />
        ) : (
          <ColorInput
            value={value}
            title="Cor de fundo"
            onPreview={(v) => previewStyles(nodes, () => ({ background: v }))}
            onCommit={write}
          />
        )}
      </TokenBound>
      <IconButton
        title={complex ? 'Usar cor sólida' : 'Usar gradiente'}
        active={complex && !isVar}
        disabled={locked || isVar}
        onClick={toggle}
      >
        {complex ? <Palette size={13} /> : <PaintBucket size={13} />}
      </IconButton>
    </div>
  );
}

function BorderFields({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const raw = common(nodes, (n) => n.style.border);
  const b = raw === null ? null : parseBorder(raw);
  const edit = (patch: Partial<Border>) =>
    void commitStyles(nodes, (n) => {
      const cur = { ...parseBorder(n.style.border), ...patch };
      if (cur.color && !cur.style && !cur.width) {
        cur.width = '1px';
        cur.style = 'solid';
      } else if ((patch.color || patch.width) && !cur.style) cur.style = 'solid';
      else if (patch.style && patch.style !== 'none' && !cur.width) cur.width = '1px';
      const v = serializeBorder(cur);
      return v ? { set: { border: v } } : { unset: ['border'] };
    });
  return (
    <>
      <TokenBound
        nodes={nodes}
        prop="border-color"
        value={b === null ? null : b.color || undefined}
        write={(v) => edit({ color: v })}
      >
        <ColorInput
          value={b === null ? null : b.color || undefined}
          title="Cor da borda"
          onCommit={(v) => edit({ color: v })}
        />
      </TokenBound>
      <div className="prop-row-2">
        <NumberInput
          label="W"
          title="Espessura"
          min={0}
          value={b === null ? null : b.width || undefined}
          disabled={locked}
          onCommit={(v) => edit({ width: v })}
        />
        <SelectInput
          value={b === null ? null : b.style}
          options={BORDER_STYLE}
          title="Estilo da borda"
          onChange={(v) => edit({ style: v })}
        />
      </div>
    </>
  );
}

export function AppearanceSection({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const opacity = common(nodes, (n) => {
    const o = parseCssNumber(n.style.opacity);
    return o ? `${Math.round(o.value * 100)}%` : undefined;
  });
  const setOpacity = (v: string) => {
    const n = parseCssNumber(v)?.value;
    void commitStyles(nodes, () =>
      v === '' || n === undefined
        ? { unset: ['opacity'] }
        : { set: { opacity: String(Math.round(Math.min(100, Math.max(0, n))) / 100) } },
    );
  };
  return (
    <Section id="props-appearance" title="Aparência">
      <Body>
        <Row label="Opacidade">
          <NumberInput
            label={<Blend size={12} />}
            title="Opacidade (%)"
            unit="%"
            min={0}
            max={100}
            value={opacity}
            placeholder="100%"
            disabled={locked}
            onPreview={(v) => {
              const n = parseCssNumber(v)?.value ?? 100;
              previewStyles(nodes, () => ({ opacity: String(n / 100) }));
            }}
            onCommit={setOpacity}
          />
        </Row>
        <Row label="Fundo">
          <Background nodes={nodes} />
        </Row>
        <Row label="Borda">
          <div className="prop-stack">
            <BorderFields nodes={nodes} />
          </div>
        </Row>
        <Row label="Raio">
          <BoxField nodes={nodes} spec={RADIUS} icon="R" title="Raio da borda" />
        </Row>
        <div className="prop-subhead">Sombras</div>
        <ShadowList nodes={nodes} />
        <Row label="Mistura">
          <StyleSelect
            nodes={nodes}
            prop="mix-blend-mode"
            options={BLEND}
            title="mix-blend-mode"
            placeholder="normal"
          />
        </Row>
        <Row label="Mist. fundo">
          <StyleSelect
            nodes={nodes}
            prop="background-blend-mode"
            options={BLEND}
            title="background-blend-mode"
            placeholder="normal"
          />
        </Row>
      </Body>
    </Section>
  );
}
