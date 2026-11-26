/**
 * Popover with the animation presets: kind tabs (In / Out / Emphasis), search and a grid grouped by
 * family. Hovering a tile plays the real preset (same keyframes and easing as the canvas) on a small
 * demo box, in a loop.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { MOTION_PRESETS, compileAnimation, presetDuration, toWaapiKeyframes } from '@mockup/core';
import type { AnimationKind, AnimationPreset, PresetGroup } from '@mockup/core';
import { KIND_LABELS } from './kinds';
import './motion.css';

export const GROUP_LABELS: Record<PresetGroup, string> = {
  fade: 'Fade',
  move: 'Move',
  scale: 'Scale',
  reveal: 'Reveal',
  '3d': '3D',
  attention: 'Attention',
  loop: 'Loops',
};
const GROUP_ORDER = Object.keys(GROUP_LABELS) as PresetGroup[];
const KINDS: AnimationKind[] = ['in', 'out', 'emphasis'];

/** Presets grouped by family, in catalog order, for a kind. */
export function presetsByGroup(
  kind: AnimationKind,
  query = '',
): { group: PresetGroup; presets: AnimationPreset[] }[] {
  const q = query.trim().toLowerCase();
  const list = MOTION_PRESETS.filter(
    (p) =>
      p.kinds.includes(kind) &&
      (!q ||
        p.name.includes(q) ||
        p.label.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)),
  );
  return GROUP_ORDER.map((group) => ({
    group,
    presets: list.filter((p) => p.group === group),
  })).filter((g) => g.presets.length > 0);
}

/** Plays `preset` on `el` in a loop; returns a stop function. */
export function playDemo(
  el: HTMLElement,
  preset: AnimationPreset,
  kind: AnimationKind,
): () => void {
  if (typeof el.animate !== 'function') return () => {};
  const { keyframes, timing } = compileAnimation({ kind, preset: preset.name });
  if (!keyframes.length) return () => {};
  const looping = timing.iterations === Infinity;
  const anim = el.animate(toWaapiKeyframes(keyframes) as Keyframe[], {
    duration: Math.max(150, timing.duration || presetDuration(preset, kind)),
    easing: timing.easing,
    iterations: Infinity,
    direction: timing.direction,
    endDelay: looping ? 0 : 450,
    fill: 'both',
  });
  return () => anim.cancel();
}

function Tile({
  preset,
  kind,
  onPick,
}: {
  preset: AnimationPreset;
  kind: AnimationKind;
  onPick: (kind: AnimationKind, preset: string) => void;
}) {
  const demo = useRef<HTMLSpanElement>(null);
  const stop = useRef<(() => void) | null>(null);
  const start = () => {
    stop.current?.();
    if (demo.current) stop.current = playDemo(demo.current, preset, kind);
  };
  const end = () => {
    stop.current?.();
    stop.current = null;
  };
  useEffect(() => end, []);
  return (
    <button
      type="button"
      className="mo-tile"
      data-testid={`motion-preset-${preset.name}`}
      title={preset.description}
      onMouseEnter={start}
      onMouseLeave={end}
      onFocus={start}
      onBlur={end}
      onClick={() => onPick(kind, preset.name)}
    >
      <span className="mo-tile-stage" data-gpu={preset.gpu}>
        <span ref={demo} className="mo-tile-box" />
      </span>
      <span className="mo-tile-label">{preset.label}</span>
    </button>
  );
}

const WIDTH = 348;

export function PresetPicker({
  anchor,
  initialKind = 'in',
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  initialKind?: AnimationKind;
  onPick: (kind: AnimationKind, preset: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<AnimationKind>(initialKind);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const groups = useMemo(() => presetsByGroup(kind, query), [kind, query]);

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const panel = anchor.closest('.panel-right')?.getBoundingClientRect();
    const right = panel ? panel.left - 8 : a.left - 8;
    const left = Math.max(8, Math.min(right - WIDTH, window.innerWidth - WIDTH - 8));
    const maxHeight = Math.min(520, window.innerHeight - 16);
    const top = Math.max(8, Math.min(a.top - 40, window.innerHeight - maxHeight - 8));
    setPos({ left, top, maxHeight });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as globalThis.Node;
      if (!root.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={root}
      className="mo-picker"
      data-testid="motion-picker"
      role="dialog"
      aria-label="Animation presets"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: WIDTH, maxHeight: pos?.maxHeight }}
    >
      <div className="mo-picker-head">
        <div className="mo-tabs" role="tablist">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`mo-tab mo-${k}${kind === k ? ' active' : ''}`}
              data-testid={`motion-kind-${k}`}
              onClick={() => setKind(k)}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <label className="mo-search">
          <Search size={12} />
          <input
            autoFocus
            value={query}
            placeholder="Search"
            data-testid="motion-search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </label>
      </div>
      <div className="mo-picker-body">
        {groups.length === 0 && <div className="mo-empty">No preset matches.</div>}
        {groups.map(({ group, presets }) => (
          <section key={group}>
            <h4 className="mo-group">{GROUP_LABELS[group]}</h4>
            <div className="mo-grid">
              {presets.map((p) => (
                <Tile key={p.name} preset={p} kind={kind} onPick={onPick} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}
