/** "Animation" section (Design tab): the node's motion list, the preset picker and one editor per animation. */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Play, Plus, Trash2 } from 'lucide-react';
import {
  NAMED_EASINGS,
  MOTION_PRESETS,
  animationDefaults,
  easingProblem,
  frameMotionTimeline,
  getMotionPreset,
  isNamedEasing,
  resolveEasing,
} from '@mockup/core';
import type { AnimationSplit, MotionParamDef, Node, NodeAnimation, Op } from '@mockup/core';
import { getFrameOf } from '../model/tree';
import { LockedContext, runOps } from '../properties/styleOps';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { ColorInput, IconButton, Row, Section, SelectInput, TextInput } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { Body } from '../properties/shared';
import { buildLabel, kindBadge, KIND_LABELS } from './kinds';
import {
  addAnimationOp,
  changePresetPatch,
  formatMs,
  parseCustomKeyframes,
  parseMs,
  removeAnimationOp,
  replaceAnimationOp,
  updateAnimationOp,
} from './motionOps';
import { EasingOptions } from './easingOptions';
import { GROUP_LABELS, PresetPicker } from './PresetPicker';
import { motionPreview } from './preview';
import './motion.css';

const send = (op: Op | null): void => {
  if (op) void runOps([op]);
};

/** Number field in `unit` (ms, px, deg, %, '' ...) that commits a plain number. */
function Num({
  label,
  title,
  value,
  unit,
  min,
  max,
  step = 1,
  onCommit,
  testId,
}: {
  label: ReactNode;
  title?: string;
  value: number;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (n: number) => void;
  testId?: string;
}) {
  const locked = useContext(LockedContext);
  return (
    <div className="mo-num" data-testid={testId}>
      <NumberInput
        label={label}
        title={title}
        value={`${value}${unit}`}
        unit={unit}
        min={min}
        max={max}
        step={step}
        disabled={locked}
        onCommit={(t) => {
          const n = unit === 'ms' ? parseMs(t) : Number.parseFloat(t);
          if (n === null || !Number.isFinite(n)) ui.toast('Enter a number', 'error');
          else if (n !== value) onCommit(n);
        }}
      />
    </div>
  );
}

const PRESET_GROUPS = (Object.keys(GROUP_LABELS) as (keyof typeof GROUP_LABELS)[])
  .map((g) => ({ group: g, presets: MOTION_PRESETS.filter((p) => p.group === g) }))
  .filter((g) => g.presets.length);

function EasingField({ value, onCommit }: { value: string; onCommit: (easing: string) => void }) {
  const [custom, setCustom] = useState(!isNamedEasing(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCustom(!isNamedEasing(value));
  }, [value]);
  const named = NAMED_EASINGS.find((e) => e.name === value);
  return (
    <>
      <select
        className="select-input"
        data-testid="motion-easing"
        value={custom ? '__custom' : value}
        title={named?.description}
        onChange={(e) => {
          if (e.target.value === '__custom') setCustom(true);
          else {
            setCustom(false);
            setError(null);
            onCommit(e.target.value);
          }
        }}
      >
        <EasingOptions extra={<option value="__custom">Custom…</option>} />
      </select>
      {custom && (
        <div className="mo-custom-easing" data-testid="motion-easing-custom">
          <TextInput
            monospace
            value={isNamedEasing(value) ? resolveEasing(value) : value}
            placeholder="cubic-bezier(0.2, 0.8, 0.2, 1)"
            onCommit={(t) => {
              const problem = easingProblem(t.trim());
              setError(problem);
              if (problem) ui.toast(problem, 'error');
              else onCommit(t.trim());
            }}
          />
          {error && <div className="mo-error">{error}</div>}
        </div>
      )}
    </>
  );
}

function ParamField({
  def,
  value,
  onCommit,
}: {
  def: MotionParamDef;
  value: number | string;
  onCommit: (v: number | string) => void;
}) {
  if (def.type === 'color') {
    return (
      <Row label={<span title={def.description}>{def.label}</span>}>
        <div data-testid={`motion-param-${def.name}`}>
          <ColorInput
            value={String(value)}
            onCommit={(t) => {
              if (/^#[0-9a-f]{3,8}$/i.test(t.trim())) onCommit(t.trim());
              else ui.toast('Use a hexadecimal color (#rrggbb)', 'error');
            }}
          />
        </div>
      </Row>
    );
  }
  const unit = def.unit === 'x' || !def.unit ? '' : def.unit;
  return (
    <Row label={<span title={def.description}>{def.label}</span>}>
      <Num
        testId={`motion-param-${def.name}`}
        label={unit || '×'}
        title={def.description}
        value={Number(value)}
        unit={unit}
        min={def.min}
        max={def.max}
        step={def.step ?? 1}
        onCommit={onCommit}
      />
    </Row>
  );
}

function CustomKeyframes({
  node,
  index,
  anim,
}: {
  node: Node;
  index: number;
  anim: NodeAnimation;
}) {
  const shown = JSON.stringify(anim.keyframes ?? [{ opacity: 0 }, { opacity: 1 }], null, 2);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(shown), [shown]);
  return (
    <div className="mo-keyframes">
      <textarea
        className="mono mo-textarea"
        data-testid="motion-keyframes"
        spellCheck={false}
        value={text}
        rows={7}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        onBlur={() => {
          if (text === shown) return;
          const r = parseCustomKeyframes(anim, text);
          if ('error' in r) {
            setError(r.error);
            ui.toast(r.error, 'error');
            return;
          }
          setError(null);
          send(replaceAnimationOp(node, index, r.animation));
        }}
      />
      {error && <div className="mo-error">{error}</div>}
    </div>
  );
}

function AnimationRow({
  node,
  index,
  anim,
  selected,
}: {
  node: Node;
  index: number;
  anim: NodeAnimation;
  selected: boolean;
}) {
  const [open, setOpen] = useState(selected);
  const ref = useRef<HTMLDivElement>(null);
  const frame = useDoc((s) => (s.doc ? getFrameOf(s.doc, node.id) : undefined));
  const clicks = useMemo(() => (frame ? frameMotionTimeline(frame).clicks : 0), [frame]);
  const d = animationDefaults(anim);
  const preset = getMotionPreset(anim.preset);
  const badge = kindBadge(anim.kind, d.iterations);
  const patch = (p: Partial<NodeAnimation>) => send(updateAnimationOp(node, index, p));

  useEffect(() => {
    if (!selected) return;
    setOpen(true);
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const maxBuild = Math.min(99, Math.max(clicks + 1, d.build));
  const buildOptions = Array.from({ length: maxBuild + 1 }, (_, b) => b);
  const isText = node.type === 'text';

  const preview = () => {
    if (!frame) return;
    const item = frameMotionTimeline(frame).items.find(
      (i) => i.nodeId === node.id && i.index === index,
    );
    motionPreview.play(frame.id, item?.start ?? 0);
  };

  return (
    <div
      ref={ref}
      className={`mo-row${selected ? ' selected' : ''}${open ? ' open' : ''}`}
      data-testid="motion-row"
      data-index={index}
      data-node={node.id}
    >
      <div className="mo-row-head">
        <button
          type="button"
          className="mo-row-main"
          aria-expanded={open}
          data-testid="motion-row-toggle"
          onClick={() => {
            setOpen(!open);
            ui.selectMotion({ nodeId: node.id, index });
          }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className={`mo-badge ${badge.cls}`}>{badge.label}</span>
          <span className="mo-row-title">{preset?.label ?? anim.preset}</span>
          <span className="mo-row-meta">
            {buildLabel(d.build)} · {formatMs(d.duration)}
          </span>
        </button>
        <IconButton
          title="Preview from this animation"
          data-testid="motion-preview"
          onClick={preview}
        >
          <Play size={12} />
        </IconButton>
        <IconButton
          title="Remove animation"
          data-testid="motion-remove"
          onClick={() => {
            ui.selectMotion(null);
            send(removeAnimationOp(node, index));
          }}
        >
          <Trash2 size={12} />
        </IconButton>
      </div>
      {open && (
        <div className="mo-row-body">
          <Row label="Preset">
            <select
              className="select-input"
              data-testid="motion-preset"
              value={anim.preset}
              title={preset?.description}
              onChange={(e) => patch(changePresetPatch(anim, e.target.value))}
            >
              {!preset && <option value={anim.preset}>{anim.preset}</option>}
              {PRESET_GROUPS.map((g) => (
                <optgroup key={g.group} label={GROUP_LABELS[g.group]}>
                  {g.presets.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Row>
          {preset && preset.kinds.length > 1 && (
            <Row label="Kind">
              <SelectInput
                value={anim.kind}
                title="When it plays"
                options={preset.kinds.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
                onChange={(k) => k && patch({ kind: k as NodeAnimation['kind'] })}
              />
            </Row>
          )}
          <Row label="Timing">
            <Num
              testId="motion-duration"
              label="D"
              title="Duration (ms)"
              value={d.duration}
              unit="ms"
              min={0}
              step={10}
              onCommit={(n) => patch({ duration: n })}
            />
            <Num
              testId="motion-delay"
              label="Δ"
              title="Delay (ms)"
              value={d.delay}
              unit="ms"
              min={0}
              step={10}
              onCommit={(n) => patch({ delay: n > 0 ? n : undefined })}
            />
          </Row>
          <Row label="Easing">
            <EasingField value={d.easing} onCommit={(easing) => patch({ easing })} />
          </Row>
          <Row label="Start">
            <select
              className="select-input"
              data-testid="motion-build"
              value={d.build}
              onChange={(e) => {
                const b = Number(e.target.value);
                patch({ build: b > 0 ? b : undefined });
              }}
            >
              {buildOptions.map((b) => (
                <option key={b} value={b}>
                  {b === 0 ? 'On slide start' : `Click ${b}`}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Repeat">
            <Num
              testId="motion-iterations"
              label="×"
              title="Number of plays"
              value={d.iterations === 'infinite' ? 1 : d.iterations}
              unit=""
              min={1}
              step={1}
              onCommit={(n) => patch({ iterations: n })}
            />
            <IconButton
              title="Loop forever"
              active={d.iterations === 'infinite'}
              data-testid="motion-infinite"
              className="mo-inf"
              onClick={() => patch({ iterations: d.iterations === 'infinite' ? 1 : 'infinite' })}
            >
              ∞
            </IconButton>
            <label className="mo-check" title="Alternate direction on every other play">
              <input
                type="checkbox"
                data-testid="motion-alternate"
                checked={!!anim.alternate}
                onChange={(e) => patch({ alternate: e.target.checked ? true : undefined })}
              />
              <span>Yoyo</span>
            </label>
          </Row>
          <Row label="Split">
            <select
              className="select-input"
              data-testid="motion-split"
              value={anim.split ?? ''}
              title="Animate each child, word or character instead of the node"
              onChange={(e) => {
                const v = e.target.value as AnimationSplit | '';
                patch({ split: v || undefined, stagger: undefined });
              }}
            >
              <option value="">None</option>
              <option value="children">Children</option>
              <option value="words" disabled={!isText}>
                Words{isText ? '' : ' (text only)'}
              </option>
              <option value="chars" disabled={!isText}>
                Characters{isText ? '' : ' (text only)'}
              </option>
            </select>
            {anim.split && (
              <Num
                testId="motion-stagger"
                label="↦"
                title="Stagger between targets (ms)"
                value={d.stagger}
                unit="ms"
                min={0}
                step={5}
                onCommit={(n) => patch({ stagger: n })}
              />
            )}
          </Row>
          {preset?.params.map((p) => (
            <ParamField
              key={p.name}
              def={p}
              value={anim.params?.[p.name] ?? p.default}
              onCommit={(v) => {
                const params = { ...anim.params, [p.name]: v };
                if (v === p.default) delete params[p.name];
                patch({ params: Object.keys(params).length ? params : undefined });
              }}
            />
          ))}
          {anim.preset === 'custom' && <CustomKeyframes node={node} index={index} anim={anim} />}
        </div>
      )}
    </div>
  );
}

export function MotionSection({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const selection = useUi((s) => s.motionSelection);
  const [picker, setPicker] = useState(false);
  const [cascade, setCascade] = useState(0);
  const addRef = useRef<HTMLButtonElement>(null);
  const multi = nodes.length > 1;
  const count = nodes.reduce((n, node) => n + (node.animations?.length ?? 0), 0);

  return (
    <Section
      id="props-motion"
      title={count ? `Animation (${count})` : 'Animation'}
      actions={
        <button
          ref={addRef}
          type="button"
          className="icon-btn"
          title="Add animation"
          aria-label="Add animation"
          data-testid="motion-add"
          disabled={locked}
          onClick={() => setPicker((p) => !p)}
        >
          <Plus size={13} />
        </button>
      }
    >
      <Body>
        {count === 0 && (
          <div className="prop-subtitle" data-testid="motion-empty">
            No animation. Add one to make {multi ? 'these layers' : 'this layer'} enter, exit or
            catch attention.
          </div>
        )}
        {nodes.map((node) => (
          <div key={node.id} className="mo-node" data-testid="motion-node">
            {multi && (node.animations?.length ?? 0) > 0 && (
              <div className="prop-subhead">{node.name}</div>
            )}
            {node.animations?.map((anim, i) => (
              <AnimationRow
                key={i}
                node={node}
                index={i}
                anim={anim}
                selected={selection?.nodeId === node.id && selection.index === i}
              />
            ))}
          </div>
        ))}
        {multi && (
          <Row label="Cascade">
            <Num
              testId="motion-cascade"
              label="Δ"
              title="Each successive selected layer starts this many ms later"
              value={cascade}
              unit="ms"
              min={0}
              step={10}
              onCommit={setCascade}
            />
          </Row>
        )}
        <button
          type="button"
          className="btn mo-add-btn"
          data-testid="motion-add-button"
          disabled={locked}
          onClick={() => setPicker(true)}
        >
          <Plus size={12} /> Add animation
        </button>
      </Body>
      {picker && addRef.current && (
        <PresetPicker
          anchor={addRef.current}
          onClose={() => setPicker(false)}
          onPick={(kind, preset) => {
            setPicker(false);
            const first = nodes[0]?.animations?.length ?? 0;
            send(addAnimationOp(nodes, { kind, preset }, multi ? cascade : 0));
            if (nodes[0]) ui.selectMotion({ nodeId: nodes[0].id, index: first });
          }}
        />
      )}
    </Section>
  );
}
