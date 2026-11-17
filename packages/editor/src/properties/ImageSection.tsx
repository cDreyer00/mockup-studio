/** "Image" section: replace file, fit, filters, mask, crop and placeholder. */
import { useContext, useRef, useState } from 'react';
import { Crop, ImagePlus, RotateCcw, Sparkles } from 'lucide-react';
import {
  CLIP_PATH_PRESETS,
  IMAGE_FILTERS,
  OBJECT_FIT_VALUES,
  PLACEHOLDER_KINDS,
  clipPathPresetOf,
  parseCrop,
} from '@mockup/core';
import type { ImageFilterDef, Node } from '@mockup/core';
import { pickImageFile } from '../canvas/imageTool';
import { cropFitWarning, isEmptyCrop } from '../canvas/crop';
import { removeCrop, startCrop } from '../canvas/cropActions';
import { daemon } from '../client/daemon';
import { features } from '../client/features';
import { ui } from '../state/uiStore';
import { Row, SelectInput, Section } from '../ui/controls';
import {
  CLIP_PRESET_KEYS,
  POSITION_GRID,
  clipPathDelta,
  filterDelta,
  filterPreview,
  filterValues,
  hasActiveFilters,
  objectPositionDelta,
  positionKey,
  resetFiltersDelta,
} from './imageOps';
import {
  Body,
  DraftInput,
  LockedContext,
  commitStyles,
  common,
  previewStyles,
  runOps,
} from './shared';

const KIND_LABEL: Record<string, string> = {
  avatar: 'Avatar',
  product: 'Product',
  landscape: 'Landscape',
  logo: 'Logo',
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Common value of the `name` filter in the selection (`undefined` if they differ; neutral if absent). */
function commonFilter(nodes: readonly Node[], def: ImageFilterDef): number | undefined {
  const values = nodes.map((n) => filterValues(n.style.filter)[def.name] ?? def.neutral);
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

function FilterRow({ nodes, def }: { nodes: readonly Node[]; def: ImageFilterDef }) {
  const locked = useContext(LockedContext);
  const value = commonFilter(nodes, def);
  const [drag, setDrag] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const dirty = useRef(false);
  const shown = drag ?? value ?? def.neutral;

  const preview = (v: number): void => {
    dirty.current = true;
    setDrag(v);
    previewStyles(nodes, (n) => ({ filter: filterPreview(n.style.filter, def.name, v) || 'none' }));
  };
  const commit = (v: number): void => {
    const next = Math.min(def.max, Math.max(def.min, v));
    dirty.current = false;
    void commitStyles(nodes, (n) => filterDelta(n.style.filter, def.name, next)).finally(() =>
      setDrag(null),
    );
  };
  const release = (): void => {
    if (dirty.current && drag !== null) commit(drag);
  };
  return (
    <div className="img-filter" title={def.label}>
      <span className="img-filter-label">{def.label}</span>
      <input
        type="range"
        className="img-filter-range"
        data-testid={`image-filter-${def.name}`}
        min={def.min}
        max={def.max}
        step={def.unit === 'px' ? 0.5 : 1}
        value={shown}
        disabled={locked}
        onChange={(e) => preview(Number(e.target.value))}
        onPointerUp={release}
        onKeyUp={release}
        onBlur={release}
      />
      <input
        type="number"
        className="text-input img-filter-num"
        data-testid={`image-filter-${def.name}-value`}
        min={def.min}
        max={def.max}
        value={text ?? (value === undefined ? '' : String(value))}
        placeholder={value === undefined ? 'Mixed' : undefined}
        disabled={locked}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text;
          setText(null);
          if (t === null || t.trim() === '' || !Number.isFinite(Number(t))) return;
          if (Number(t) !== value) commit(Number(t));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      <span className="img-filter-unit">{def.unit}</span>
    </div>
  );
}

function Filters({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const active = nodes.some((n) => hasActiveFilters(n.style.filter));
  return (
    <div className="img-block" data-testid="image-filters">
      {IMAGE_FILTERS.map((def) => (
        <FilterRow key={def.name} nodes={nodes} def={def} />
      ))}
      <button
        type="button"
        className="btn img-reset"
        data-testid="image-filters-reset"
        disabled={locked || !active}
        onClick={() => void commitStyles(nodes, (n) => resetFiltersDelta(n.style.filter))}
      >
        <RotateCcw size={12} /> Reset
      </button>
    </div>
  );
}

function Placeholder({ nodes }: { nodes: readonly Node[] }) {
  const [kind, setKind] = useState<string>('avatar');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const generate = async (): Promise<void> => {
    setBusy(true);
    try {
      for (const n of nodes) {
        await features.placeholder({
          nodeId: n.id,
          kind,
          ...(seed.trim() ? { seed: seed.trim() } : {}),
        });
      }
    } catch (e) {
      ui.toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="img-block">
      <Row label="Type">
        <SelectInput
          value={kind}
          options={PLACEHOLDER_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }))}
          title="Placeholder type"
          onChange={(v) => v && setKind(v)}
        />
      </Row>
      <Row label="Seed">
        <input
          className="text-input"
          data-testid="placeholder-seed"
          value={seed}
          placeholder="optional: changes the artwork"
          spellCheck={false}
          onChange={(e) => setSeed(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Row>
      <button
        type="button"
        className="btn"
        data-testid="placeholder-generate"
        disabled={busy}
        onClick={() => void generate()}
      >
        <Sparkles size={12} /> Generate placeholder
      </button>
    </div>
  );
}

export function ImageSection({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const fit = common(nodes, (n) => n.style['object-fit']);
  const position = common(nodes, (n) => n.style['object-position']);
  const clip = common(nodes, (n) => n.style['clip-path']);
  const single = nodes.length === 1 ? nodes[0]! : null;
  const cropValue = single ? parseCrop(single.style['object-view-box']) : null;
  const cropped = !!single && !!cropValue && !isEmptyCrop(cropValue);
  const posKey = positionKey(position);
  const preset = typeof clip === 'string' ? clipPathPresetOf(clip) : null;

  const replace = async (): Promise<void> => {
    const file = await pickImageFile();
    if (!file) return;
    try {
      const src = await daemon.uploadAsset(file, file.name);
      await runOps([{ type: 'setSrc', changes: nodes.map((n) => ({ nodeId: n.id, src })) }]);
    } catch (e) {
      ui.toast(errMsg(e), 'error');
    }
  };

  return (
    <Section id="props-image" title="Image" defaultOpen>
      <div data-testid="image-section">
        <Body>
          <button
            type="button"
            className="btn img-wide"
            data-testid="image-replace"
            onClick={() => void replace()}
          >
            <ImagePlus size={13} /> Replace image…
          </button>

          <Row label="Fit">
            <div className="prop-seg img-fit">
              {OBJECT_FIT_VALUES.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`img-seg-btn${fit === v ? ' active' : ''}`}
                  data-testid={`image-fit-${v}`}
                  aria-pressed={fit === v}
                  onClick={() => void commitStyles(nodes, () => ({ set: { 'object-fit': v } }))}
                >
                  {v}
                </button>
              ))}
            </div>
          </Row>

          <Row label="Position">
            <div className="img-position">
              <div className="img-pos-grid" data-testid="image-position-grid">
                {POSITION_GRID.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    title={p.key}
                    className={`img-pos-cell${posKey === p.key ? ' active' : ''}`}
                    data-testid={`image-position-${p.key}`}
                    onClick={() => void commitStyles(nodes, () => objectPositionDelta(p.key))}
                  />
                ))}
              </div>
              <DraftInput
                mono
                value={position}
                placeholder="50% 50%"
                testId="image-position-input"
                onCommit={(v) => void commitStyles(nodes, () => objectPositionDelta(v))}
              />
            </div>
          </Row>

          <div className="img-title">Filters</div>
          <Filters nodes={nodes} />

          <div className="img-title">Mask</div>
          <div className="img-block">
            <div className="img-clips">
              <button
                type="button"
                className={`img-clip${clip === undefined ? ' active' : ''}`}
                data-testid="image-clip-none"
                title="None"
                onClick={() => void commitStyles(nodes, () => clipPathDelta('none'))}
              >
                <span className="img-clip-none">∅</span>
              </button>
              {CLIP_PRESET_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`img-clip${preset === k ? ' active' : ''}`}
                  data-testid={`image-clip-${k}`}
                  title={CLIP_PATH_PRESETS[k]!.label}
                  onClick={() => void commitStyles(nodes, () => clipPathDelta(k))}
                >
                  <span style={{ clipPath: CLIP_PATH_PRESETS[k]!.value }} />
                </button>
              ))}
            </div>
            <DraftInput
              mono
              value={clip}
              placeholder="free clip-path"
              testId="image-clip-input"
              onCommit={(v) => void commitStyles(nodes, () => clipPathDelta(v))}
            />
          </div>

          <div className="img-title">Crop</div>
          <div className="img-block">
            <div className="img-actions">
              <button
                type="button"
                className="btn"
                data-testid="image-crop-button"
                disabled={locked || !single}
                title={single ? 'Crop with handles (or double-click the image)' : 'Select an image'}
                onClick={() => single && startCrop(single.id)}
              >
                <Crop size={12} /> Crop
              </button>
              <button
                type="button"
                className="btn"
                data-testid="image-crop-remove"
                disabled={locked || !cropped}
                onClick={() => single && void removeCrop(single.id)}
              >
                Remove crop
              </button>
            </div>
            {cropped && cropValue && (
              <div className="img-hint" data-testid="image-crop-info">
                Crop: {cropValue.top}% / {cropValue.right}% / {cropValue.bottom}% / {cropValue.left}
                %
              </div>
            )}
            {single && cropFitWarning(single.style) && (
              <div className="img-hint warn" data-testid="image-crop-warning">
                The crop uses <code>object-view-box</code> (Chromium; so does the exported code).
                With this fit, the crop is calculated as if the fit were <code>fill</code>.
              </div>
            )}
          </div>

          <div className="img-title">Placeholder</div>
          <Placeholder nodes={nodes} />
        </Body>
      </div>
    </Section>
  );
}
