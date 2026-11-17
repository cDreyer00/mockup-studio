/** Grid mode of the Layout panel (columns, rows, gaps, alignment) and the "Grid cell" of the children. */
import { isGridContainer, parseGridPlacement, serializeTrackList } from '@mockup/core';
import type { Node } from '@mockup/core';
import { Plus, X } from 'lucide-react';
import { useContext } from 'react';
import { placementDelta } from '../canvas/gridDrag';
import { IconButton, Row, Section } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { Body, DraftInput, LockedContext, commitStyle, commitStyles, common } from './shared';
import type { NodeCtx } from './shared';
import {
  TRACK_UNITS,
  addTrack,
  changeUnit,
  draftsFromStyle,
  draftsToStyle,
  gapDelta,
  placeItemsDelta,
  readGaps,
  readPlaceItems,
  removeTrack,
  updateTrack,
} from './gridTracks';
import type { TrackDraft, TrackUnit } from './gridTracks';

/** Styles to turn into a grid: `display: grid` and, with no columns defined, two `1fr` columns. */
export function gridModeStyles(style: Record<string, string>): Record<string, string> {
  const set: Record<string, string> = { display: 'grid' };
  if (!style['grid-template-columns'] || style['grid-template-columns'] === 'none') {
    set['grid-template-columns'] = serializeTrackList(['1fr', '1fr']);
  }
  return set;
}

const ALIGN_OPTIONS = [
  { value: '', label: 'Stretch' },
  { value: 'start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'end', label: 'End' },
  { value: 'baseline', label: 'Baseline' },
];

function NativeSelect({
  value,
  options,
  onChange,
  testId,
  title,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  testId?: string;
  title?: string;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <select
      className="select-input"
      data-testid={testId}
      title={title}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {!known && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function TrackList({ node, axis }: { node: Node; axis: 'col' | 'row' }) {
  const locked = useContext(LockedContext);
  const prop = axis === 'col' ? 'grid-template-columns' : 'grid-template-rows';
  const drafts = draftsFromStyle(node.style[prop]);
  const id = (i: number, part: string) => `grid-${axis}-${i}-${part}`;
  const apply = (next: TrackDraft[]) => void commitStyle([node], prop, draftsToStyle(next) ?? '');

  return (
    <div className="prop-tracks" data-testid={`grid-${axis}-tracks`}>
      <div className="prop-tracks-head">
        <span className="prop-subhead">{axis === 'col' ? 'Columns' : 'Rows'}</span>
        <IconButton
          title={axis === 'col' ? 'Add column' : 'Add row'}
          data-testid={`grid-${axis}-add`}
          disabled={locked}
          onClick={() => apply(addTrack(drafts))}
        >
          <Plus size={12} />
        </IconButton>
      </div>
      {drafts.map((d, i) => (
        <div className="prop-track" key={i} data-testid={`grid-${axis}-${i}`}>
          <span className="prop-track-index">{i + 1}</span>
          {d.unit === 'minmax' ? (
            <div className="prop-track-pair">
              <DraftInput
                value={d.min}
                title="Minimum"
                testId={id(i, 'min')}
                onCommit={(v) => apply(updateTrack(drafts, i, { min: v }))}
              />
              <DraftInput
                value={d.max}
                title="Maximum"
                testId={id(i, 'max')}
                onCommit={(v) => apply(updateTrack(drafts, i, { max: v }))}
              />
            </div>
          ) : d.unit === 'auto' ? (
            <span className="prop-track-auto muted">auto</span>
          ) : (
            <DraftInput
              value={d.value}
              title="Track value"
              testId={id(i, 'value')}
              onCommit={(v) => apply(updateTrack(drafts, i, { value: v }))}
            />
          )}
          <NativeSelect
            value={d.unit}
            options={TRACK_UNITS}
            title="Unit"
            testId={id(i, 'unit')}
            onChange={(u) => apply(updateTrack(drafts, i, changeUnit(d, u as TrackUnit)))}
          />
          <IconButton
            title="Remove track"
            data-testid={id(i, 'remove')}
            disabled={locked}
            onClick={() => apply(removeTrack(drafts, i))}
          >
            <X size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

function GapField({
  node,
  axis,
  label,
  testId,
}: {
  node: Node;
  axis: 'both' | 'col' | 'row';
  label: string;
  testId: string;
}) {
  const locked = useContext(LockedContext);
  const g = readGaps(node.style);
  const value = axis === 'both' ? g.both : axis === 'col' ? g.col : g.row;
  return (
    <div className="prop-field" data-testid={testId}>
      <NumberInput
        value={value}
        label={label}
        title={`Gap (${axis === 'both' ? 'columns and rows' : axis === 'col' ? 'columns' : 'rows'})`}
        min={0}
        disabled={locked}
        onCommit={(v) => void commitStyles([node], (n) => gapDelta(n.style, axis, v))}
      />
    </div>
  );
}

/** Visual editor for a grid container: tracks, gaps and item alignment. */
export function GridEditor({ node }: { node: Node }) {
  const items = readPlaceItems(node.style);
  return (
    <div className="prop-grid-editor" data-testid="grid-editor">
      <TrackList node={node} axis="col" />
      <TrackList node={node} axis="row" />
      <Row label="Gap">
        <GapField node={node} axis="both" label="G" testId="grid-gap" />
      </Row>
      <Row label="Col / Row">
        <div className="prop-row-2">
          <GapField node={node} axis="col" label="C" testId="grid-gap-col" />
          <GapField node={node} axis="row" label="R" testId="grid-gap-row" />
        </div>
      </Row>
      <Row label="Align H">
        <NativeSelect
          value={items.justify ?? ''}
          options={ALIGN_OPTIONS.filter((o) => o.value !== 'baseline')}
          title="justify-items"
          testId="grid-justify-items"
          onChange={(v) => void commitStyles([node], (n) => placeItemsDelta(n.style, 'justify', v))}
        />
      </Row>
      <Row label="Align V">
        <NativeSelect
          value={items.align ?? ''}
          options={ALIGN_OPTIONS}
          title="align-items"
          testId="grid-align-items"
          onChange={(v) => void commitStyles([node], (n) => placeItemsDelta(n.style, 'align', v))}
        />
      </Row>
    </div>
  );
}

/* ------------------------------ grid cell ------------------------------ */

type CellKey = 'column' | 'row' | 'columnSpan' | 'rowSpan';

const CELL_FIELDS: { key: CellKey; label: string; testId: string; title: string }[] = [
  {
    key: 'column',
    label: 'Column',
    testId: 'grid-cell-column',
    title: 'Start column (grid-column)',
  },
  { key: 'row', label: 'Row', testId: 'grid-cell-row', title: 'Start row (grid-row)' },
  { key: 'columnSpan', label: 'Col span', testId: 'grid-cell-colspan', title: 'Columns spanned' },
  { key: 'rowSpan', label: 'Row span', testId: 'grid-cell-rowspan', title: 'Rows spanned' },
];

/** Typed text → integer >= 1, `null` (empty = auto) or `undefined` (invalid: ignored). */
export function parseCellInput(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '' || t.toLowerCase() === 'auto') return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = parseInt(t, 10);
  return n >= 1 ? n : undefined;
}

/** Section for children of a grid container: column, row and span (`grid-column`/`grid-row`). */
export function GridCellSection({ ctxs }: { ctxs: readonly NodeCtx[] }) {
  if (ctxs.length === 0 || !ctxs.every((c) => c.parent && isGridContainer(c.parent.style))) {
    return null;
  }
  const nodes = ctxs.map((c) => c.node);
  return (
    <Section id="props-grid-cell" title="Grid cell">
      <Body>
        <div className="prop-grid-2" data-testid="grid-cell">
          {CELL_FIELDS.map((f) => {
            const value = common(nodes, (n) => {
              const v = parseGridPlacement(n.style)[f.key];
              return v === undefined ? '' : String(v);
            });
            return (
              <label className="prop-cell-field" key={f.key} title={f.title}>
                <span className="prop-subhead">{f.label}</span>
                <DraftInput
                  value={value}
                  placeholder="auto"
                  title={f.title}
                  testId={f.testId}
                  onCommit={(text) => {
                    const v = parseCellInput(text);
                    if (v === undefined) return;
                    void commitStyles(nodes, (n) => placementDelta(n.style, { [f.key]: v }));
                  }}
                />
              </label>
            );
          })}
        </div>
      </Body>
    </Section>
  );
}
