/** "Effect" section: type, presets and one control per catalog parameter (`effect` nodes of the same kind). */
import { useEffect, useRef, useState } from 'react';
import { EFFECTS, getEffect, presetParams, resolveEffectParams } from '@mockup/core';
import type { EffectParamDef, EffectSpec, MediaParamValue, Node } from '@mockup/core';
import { parseParamValue, paramValue, withParam } from '../effects/params';
import { ui } from '../state/uiStore';
import { ColorInput, Row, SelectInput, Section, TextInput } from '../ui/controls';
import { Body, runOps } from './shared';
import '../effects/effects.css';

type Params = Record<string, MediaParamValue>;

/**
 * Slider + number. Dragging only changes the displayed value (local draft); the `setMedia` op is sent
 * only once when the control is released (native `change` event), so one drag = one undo
 * step.
 */
function NumberParam({
  def,
  value,
  onCommit,
}: {
  def: EffectParamDef;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const range = useRef<HTMLInputElement>(null);
  const commitRef = useRef({ onCommit, value });
  commitRef.current = { onCommit, value };
  useEffect(() => setDraft(null), [value]);
  useEffect(() => {
    const el = range.current;
    if (!el) return;
    const onChange = () => {
      const v = Number(el.value);
      if (v === commitRef.current.value) setDraft(null);
      else commitRef.current.onCommit(v);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);
  const shown = draft ?? value;
  return (
    <div className="fx-param-controls">
      <input
        ref={range}
        type="range"
        data-testid={`effect-param-${def.name}`}
        min={def.min ?? 0}
        max={def.max ?? 1}
        step={def.step ?? 0.01}
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
      />
      <div data-testid={`effect-param-${def.name}-number`}>
        <TextInput
          key={`${resetKey}:${shown}`}
          value={String(shown)}
          onCommit={(t) => {
            const v = parseParamValue(def, t);
            if (typeof v === 'number' && v !== value) onCommit(v);
            else if (v === null) {
              ui.toast(`Invalid value for ${def.label}`, 'error');
              setResetKey((k) => k + 1);
            }
          }}
        />
      </div>
    </div>
  );
}

function ParamControl({
  def,
  value,
  onCommit,
}: {
  def: EffectParamDef;
  value: MediaParamValue;
  onCommit: (v: MediaParamValue) => void;
}) {
  switch (def.type) {
    case 'number':
      return (
        <NumberParam
          def={def}
          value={typeof value === 'number' ? value : Number(def.default)}
          onCommit={onCommit}
        />
      );
    case 'color':
      return (
        <div data-testid={`effect-param-${def.name}`}>
          <ColorInput
            value={String(value)}
            onCommit={(t) => {
              const v = parseParamValue(def, t);
              if (v !== null) onCommit(v);
              else ui.toast('Use a hexadecimal color (#rrggbb)', 'error');
            }}
          />
        </div>
      );
    case 'boolean':
      return (
        <label className="fx-check">
          <input
            type="checkbox"
            data-testid={`effect-param-${def.name}`}
            checked={value === true}
            onChange={(e) => onCommit(e.target.checked)}
          />
          <span>{value === true ? 'On' : 'Off'}</span>
        </label>
      );
    case 'select':
      return (
        <div data-testid={`effect-param-${def.name}`}>
          <SelectInput
            value={String(value)}
            options={(def.options ?? []).map((o) => ({ value: o, label: o }))}
            onChange={(v) => v && onCommit(v)}
          />
        </div>
      );
  }
}

const sameParams = (a: Params, b: Params): boolean => JSON.stringify(a) === JSON.stringify(b);

export function EffectSection({ nodes }: { nodes: readonly Node[] }) {
  const effects = nodes.map((n) => n.effect);
  const first = effects[0];
  if (!first || effects.some((e) => !e || e.kind !== first.kind)) return null;
  const kind = first.kind;
  const def = getEffect(kind);
  const current = resolveEffectParams(kind, first.params);

  const apply = (fn: (spec: EffectSpec) => EffectSpec): void => {
    void runOps([
      {
        type: 'setMedia',
        changes: nodes.map((n) => ({ nodeId: n.id, effect: fn(n.effect!) })),
      },
    ]);
  };

  return (
    <Section id="props-effect" title="Effect">
      <Body>
        <Row label="Type">
          <div data-testid="effect-kind">
            <SelectInput
              value={kind}
              options={EFFECTS.map((e) => ({ value: e.kind, label: e.label }))}
              title="Effect type"
              onChange={(k) => k && k !== kind && apply(() => ({ kind: k, params: {} }))}
            />
          </div>
        </Row>
        {!def && <div className="prop-subtitle">Unknown effect in the catalog: {kind}</div>}
        {def && def.presets.length > 0 && (
          <div className="fx-chips" data-testid="effect-presets">
            {def.presets.map((p) => {
              const params = presetParams(kind, p.name) ?? {};
              return (
                <button
                  key={p.name}
                  type="button"
                  className={`fx-chip${sameParams(params, current) ? ' active' : ''}`}
                  data-testid={`effect-chip-${p.name}`}
                  onClick={() => apply((s) => ({ ...s, params: { ...p.params } }))}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        )}
        {def?.params.map((p) => (
          <div className="fx-param" key={p.name} title={p.description}>
            <span className="fx-param-label">{p.label}</span>
            <ParamControl
              def={p}
              value={paramValue(p, current)}
              onCommit={(v) => apply((s) => ({ ...s, params: withParam(s.params, p.name, v) }))}
            />
          </div>
        ))}
        {def && (
          <button
            type="button"
            className="btn"
            data-testid="effect-reset"
            onClick={() => apply((s) => ({ ...s, params: {} }))}
          >
            Restore defaults
          </button>
        )}
      </Body>
    </Section>
  );
}
