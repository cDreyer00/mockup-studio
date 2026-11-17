import { useContext } from 'react';
import { RotateCw } from 'lucide-react';
import { buildPositionOps } from '../actions';
import { canvasApi } from '../canvas/canvasApi';
import { pxValue } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { SelectInput, Section } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { parseCssNumber } from '../ui/units';
import { getRotation, setRotation } from './css';
import { isFillFlex, isMainAxis, sizeMode, sizeModeChange } from './size';
import type { Axis, SizeModeKind } from './size';
import {
  Body,
  LockedContext,
  StyleSelect,
  commitStyles,
  common,
  previewStyles,
  runOps,
} from './shared';
import type { NodeCtx } from './shared';
import { TokenBound } from './TokenBinding';

const isFree = (c: NodeCtx): boolean =>
  c.isRoot || c.node.style.position === 'absolute' || c.node.style.position === 'fixed';

const xyOf = (c: NodeCtx): { x: number; y: number } =>
  c.isRoot
    ? { x: c.node.position?.x ?? 0, y: c.node.position?.y ?? 0 }
    : {
        x: pxValue(c.node.style.left) ?? c.node.position?.x ?? 0,
        y: pxValue(c.node.style.top) ?? c.node.position?.y ?? 0,
      };

function commonNum(values: number[]): string | null {
  return values.every((v) => v === values[0]) ? `${values[0]}px` : null;
}

function PositionFields({ ctxs }: { ctxs: readonly NodeCtx[] }) {
  const locked = useContext(LockedContext);
  const xs = ctxs.map((c) => xyOf(c).x);
  const ys = ctxs.map((c) => xyOf(c).y);
  const target = (axis: 'x' | 'y', value: number, c: NodeCtx) => {
    const cur = xyOf(c);
    return axis === 'x' ? { x: value, y: cur.y } : { x: cur.x, y: value };
  };
  const preview = (axis: 'x' | 'y', v: string) => {
    const n = parseCssNumber(v)?.value;
    if (n === undefined) return;
    ui.setPreview(
      Object.fromEntries(
        ctxs.map((c) => {
          const p = target(axis, n, c);
          return [
            c.node.id,
            c.isRoot ? { position: p } : { style: { left: `${p.x}px`, top: `${p.y}px` } },
          ];
        }),
      ),
    );
  };
  const commit = (axis: 'x' | 'y', v: string) => {
    const n = parseCssNumber(v)?.value;
    const doc = useDoc.getState().doc;
    if (n === undefined || !doc) return ui.clearPreview();
    void runOps(
      ctxs.flatMap((c) => {
        const p = target(axis, n, c);
        return buildPositionOps(doc, c.node, p.x, p.y);
      }),
    );
  };
  return (
    <div className="prop-row-2">
      <div className="prop-field" data-testid="prop-x">
        <NumberInput
          label="X"
          title="Posição X"
          value={commonNum(xs)}
          disabled={locked}
          onPreview={(v) => preview('x', v)}
          onCommit={(v) => commit('x', v)}
        />
      </div>
      <div className="prop-field" data-testid="prop-y">
        <NumberInput
          label="Y"
          title="Posição Y"
          value={commonNum(ys)}
          disabled={locked}
          onPreview={(v) => preview('y', v)}
          onCommit={(v) => commit('y', v)}
        />
      </div>
    </div>
  );
}

const MODE_LABELS: Record<SizeModeKind, string> = {
  fixed: 'Fixo',
  auto: 'Auto',
  full: '100%',
  fill: 'Fill',
  other: '',
};

function SizeField({ ctxs, axis }: { ctxs: readonly NodeCtx[]; axis: Axis }) {
  const locked = useContext(LockedContext);
  const nodes = ctxs.map((c) => c.node);
  const modes = ctxs.map((c) => sizeMode(c.node, c.parent, axis));
  const same = modes.every((m) => m.mode === modes[0]!.mode);
  const modeValue = !same
    ? null
    : modes[0]!.mode === 'other'
      ? (modes[0]!.value ?? '')
      : modes[0]!.mode;
  const canFill = ctxs.every((c) => isMainAxis(c.parent, axis));
  const options: SelectOption[] = (['fixed', 'auto', 'full'] as const).map((m) => ({
    value: m,
    label: MODE_LABELS[m],
  }));
  if (canFill) options.push({ value: 'fill', label: MODE_LABELS.fill });
  const isW = axis === 'width';
  const testId = isW ? 'prop-w' : 'prop-h';
  const value = common(nodes, (n) => n.style[axis]);
  const placeholder =
    ctxs.length === 1
      ? (() => {
          const r = canvasApi.nodeRect(ctxs[0]!.node.id);
          return r ? `${Math.round(isW ? r.w : r.h)}` : 'auto';
        })()
      : 'auto';

  const onMode = (m: string) => {
    const mode = m as SizeModeKind;
    void commitStyles(nodes, (n) => {
      const r = canvasApi.nodeRect(n.id);
      const px = pxValue(n.style[axis]) ?? (r ? (isW ? r.w : r.h) : 100);
      return sizeModeChange(n, axis, mode, px);
    });
  };

  return (
    <div className="prop-size">
      <div className="prop-field" data-testid={testId}>
        <TokenBound nodes={nodes} prop={axis} value={value}>
          <NumberInput
            label={isW ? 'W' : 'H'}
            title={isW ? 'Largura' : 'Altura'}
            value={value}
            min={0}
            disabled={locked || modes.every((m) => m.mode === 'fill')}
            placeholder={placeholder}
            onPreview={(v) => previewStyles(nodes, () => ({ [axis]: v }))}
            onCommit={(v) => {
              void commitStyles(nodes, (n) =>
                v === ''
                  ? { unset: [axis] }
                  : {
                      set: { [axis]: v },
                      unset:
                        isFillFlex(n.style.flex) &&
                        isMainAxis(ctxs.find((c) => c.node === n)?.parent, axis)
                          ? ['flex']
                          : [],
                    },
              );
            }}
          />
        </TokenBound>
      </div>
      <SelectInput
        className="prop-mode"
        title={`Modo de ${isW ? 'largura' : 'altura'}`}
        value={modeValue}
        options={options}
        onChange={onMode}
      />
    </div>
  );
}

const POSITION_OPTIONS: SelectOption[] = [
  { value: 'static', label: 'static' },
  { value: 'relative', label: 'relative' },
  { value: 'absolute', label: 'absolute' },
  { value: 'fixed', label: 'fixed' },
  { value: 'sticky', label: 'sticky' },
];

export function SizeSection({ ctxs }: { ctxs: readonly NodeCtx[] }) {
  const locked = useContext(LockedContext);
  const nodes = ctxs.map((c) => c.node);
  const showXY = ctxs.every(isFree);
  const rotations = nodes.map((n) => getRotation(n.style.transform));
  const rot = rotations.every((r) => r === rotations[0])
    ? rotations[0]
      ? `${rotations[0]}deg`
      : ''
    : null;
  const showPosition = ctxs.every((c) => !c.isRoot);

  return (
    <Section id="props-size" title="Posição e tamanho">
      <Body>
        {showXY && <PositionFields ctxs={ctxs} />}
        <SizeField ctxs={ctxs} axis="width" />
        <SizeField ctxs={ctxs} axis="height" />
        <div className="prop-row-2">
          <NumberInput
            label={<RotateCw size={12} />}
            title="Rotação (graus)"
            unit="deg"
            value={rot}
            placeholder="0°"
            disabled={locked}
            onPreview={(v) => {
              const deg = parseCssNumber(v)?.value ?? 0;
              previewStyles(nodes, (n) => ({ transform: setRotation(n.style.transform, deg) }));
            }}
            onCommit={(v) => {
              const deg = v === '' ? 0 : parseCssNumber(v)?.value;
              if (deg === undefined) return ui.toast('Rotação inválida', 'error');
              void commitStyles(nodes, (n) => {
                const t = setRotation(n.style.transform, deg);
                return t ? { set: { transform: t } } : { unset: ['transform'] };
              });
            }}
          />
          {showPosition && (
            <StyleSelect
              nodes={nodes}
              prop="position"
              options={POSITION_OPTIONS}
              title="Position"
              placeholder="static"
            />
          )}
        </div>
      </Body>
    </Section>
  );
}
