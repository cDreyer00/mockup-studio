/** Painel de vetor: preenchimento, traço e combinações dos nós svg selecionados. */
import { useContext } from 'react';
import type { ReactNode } from 'react';
import { Minus, PenLine, Plus } from 'lucide-react';
import { BOOLEAN_OPS, buildSetVectorOps, ensureVector, setVectorPaint } from '@mockup/core';
import type {
  BooleanOp,
  Node,
  Op,
  Vector,
  VectorGradient,
  VectorGradientStop,
  VectorPaint,
  VectorPaintPatch,
  VectorPath,
} from '@mockup/core';
import { ui } from '../state/uiStore';
import { booleanOp, flatten } from '../vector/vectorActions';
import { ColorInput, IconButton, Row, SelectInput, Section, TextInput } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { Body, LockedContext, runOps } from './shared';

const FILL_MODES: SelectOption[] = [
  { value: 'none', label: 'Nenhum' },
  { value: 'solid', label: 'Sólido' },
  { value: 'linear', label: 'Gradiente linear' },
  { value: 'radial', label: 'Gradiente radial' },
];
const CAPS: SelectOption[] = ['butt', 'round', 'square'].map((v) => ({ value: v, label: v }));
const JOINS: SelectOption[] = ['miter', 'round', 'bevel'].map((v) => ({ value: v, label: v }));
const BOOL_LABEL: Record<BooleanOp, string> = {
  union: 'União',
  subtract: 'Subtração',
  intersect: 'Interseção',
  exclude: 'Exclusão',
};

const DEFAULT_STOPS: VectorGradientStop[] = [
  { offset: 0, color: '#2dd4bf' },
  { offset: 1, color: '#6366f1' },
];

function tryEnsure(node: Node): Vector | null {
  try {
    return ensureVector(node);
  } catch {
    return null;
  }
}

type FillMode = 'none' | 'solid' | 'linear' | 'radial';

export function paintMode(p: VectorPaint | undefined): FillMode {
  if (p === undefined || p === 'none') return 'none';
  return typeof p === 'string' ? 'solid' : p.type;
}

/** Aplica um patch de tinta a todos os paths dos nós, numa única op `setVector`. */
function applyPaint(nodes: readonly Node[], patch: VectorPaintPatch): Promise<void> {
  const ops: Op[] = nodes.flatMap((n) => {
    const v = tryEnsure(n);
    if (!v || v.paths.length === 0) return [];
    return buildSetVectorOps(n.id, setVectorPaint(v, patch));
  });
  if (ops.length > 1) {
    // Junta as mudanças numa só op (uma entrada de undo).
    const changes = ops.flatMap((o) => (o.type === 'setVector' ? o.changes : []));
    return runOps([{ type: 'setVector', changes }]);
  }
  return runOps(ops);
}

const solidOf = (p: VectorPaint | undefined): string | undefined =>
  typeof p === 'string' ? (p === 'none' ? undefined : p) : undefined;

/** Editor de paradas de um gradiente (2 ou mais). */
function GradientEditor({
  gradient,
  onChange,
  testPrefix,
}: {
  gradient: VectorGradient;
  onChange: (g: VectorGradient) => void;
  testPrefix: string;
}) {
  const stops = gradient.stops;
  const setStop = (i: number, patch: Partial<VectorGradientStop>) =>
    onChange({ ...gradient, stops: stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const add = () => {
    const last = stops[stops.length - 1]!;
    const prev = stops[stops.length - 2] ?? last;
    onChange({
      ...gradient,
      stops: [
        ...stops,
        { offset: Math.min(1, (prev.offset + last.offset) / 2 + 0.001), color: last.color },
      ].sort((a, b) => a.offset - b.offset),
    });
  };
  return (
    <div className="prop-stack" data-testid={`${testPrefix}-stops`}>
      {stops.map((s, i) => (
        <div className="prop-row-2" key={i}>
          <div className="vec-tid" data-testid={`${testPrefix}-stop-color-${i}`}>
            <ColorInput
              value={s.color}
              title={`Cor da parada ${i + 1}`}
              onCommit={(v) => setStop(i, { color: v })}
            />
          </div>
          <div className="vec-tid" data-testid={`${testPrefix}-stop-offset-${i}`}>
            <NumberInput
              label="%"
              title="Posição (%)"
              unit=""
              min={0}
              max={100}
              value={String(Math.round(s.offset * 100))}
              onCommit={(v) => {
                const n = Number(v);
                if (Number.isFinite(n)) setStop(i, { offset: Math.min(1, Math.max(0, n / 100)) });
              }}
            />
          </div>
          <IconButton
            title="Remover parada"
            disabled={stops.length <= 2}
            data-testid={`${testPrefix}-stop-remove-${i}`}
            onClick={() => onChange({ ...gradient, stops: stops.filter((_, j) => j !== i) })}
          >
            <Minus size={12} />
          </IconButton>
        </div>
      ))}
      <IconButton title="Adicionar parada" data-testid={`${testPrefix}-stop-add`} onClick={add}>
        <Plus size={12} />
      </IconButton>
    </div>
  );
}

function PaintEditor({
  paint,
  onPaint,
  testPrefix,
  title,
}: {
  paint: VectorPaint | undefined;
  onPaint: (p: VectorPaint | null) => void;
  testPrefix: string;
  title: string;
}) {
  const mode = paintMode(paint);
  const setMode = (m: string) => {
    if (m === mode) return;
    if (m === 'none') onPaint('none');
    else if (m === 'solid') {
      const first = typeof paint === 'object' ? paint.stops[0]?.color : undefined;
      onPaint(first ?? '#000000');
    } else {
      const stops =
        typeof paint === 'object'
          ? paint.stops
          : typeof paint === 'string' && paint !== 'none'
            ? [{ offset: 0, color: paint }, DEFAULT_STOPS[1]!]
            : DEFAULT_STOPS;
      onPaint(
        m === 'linear'
          ? { type: 'linear', stops, x1: 0, y1: 0, x2: 0, y2: 1 }
          : { type: 'radial', stops, cx: 0.5, cy: 0.5, r: 0.5 },
      );
    }
  };
  return (
    <>
      <div className="vec-tid" data-testid={`${testPrefix}-mode`}>
        <SelectInput value={mode} options={FILL_MODES} title={title} onChange={setMode} />
      </div>
      {mode === 'solid' && (
        <div className="vec-tid" data-testid={`${testPrefix}-color`}>
          <ColorInput
            value={solidOf(paint)}
            title={`${title}: cor`}
            onCommit={(v) => onPaint(v.trim() === '' ? 'none' : v.trim())}
          />
        </div>
      )}
      {typeof paint === 'object' && (
        <GradientEditor gradient={paint} onChange={onPaint} testPrefix={testPrefix} />
      )}
    </>
  );
}

function Combine({ nodes }: { nodes: readonly Node[] }) {
  const many = nodes.length >= 2;
  return (
    <>
      <div className="prop-subhead">Vetor</div>
      <Row>
        <IconButton
          title="Editar pontos (Enter)"
          disabled={nodes.length !== 1}
          data-testid="vector-edit-points"
          onClick={() => ui.editVector(nodes[0]!.id)}
        >
          <PenLine size={13} />
        </IconButton>
        <button
          type="button"
          className="vec-btn"
          data-testid="vector-flatten"
          title="Achatar: junta os caminhos num só"
          onClick={() => void flatten()}
        >
          Achatar
        </button>
      </Row>
      {many && (
        <div className="vec-bools">
          {BOOLEAN_OPS.map((op) => (
            <button
              key={op}
              type="button"
              className="vec-btn"
              data-testid={`vector-bool-${op}`}
              onClick={() => void booleanOp(op)}
            >
              {BOOL_LABEL[op]}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function VectorSection({ nodes }: { nodes: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const vectors = nodes.map(tryEnsure);
  const editable = vectors.length > 0 && vectors.every((v) => v && v.paths.length > 0);
  const first: VectorPath | undefined = vectors[0]?.paths[0];

  let body: ReactNode;
  if (!editable || !first) {
    body = (
      <div className="prop-hint" data-testid="vector-complex">
        Este SVG é complexo (filtros, máscaras, texto...) e não tem caminhos editáveis: edite o
        markup.
      </div>
    );
  } else {
    const strokeMode = paintMode(first.stroke);
    body = (
      <>
        <div className="prop-subhead">Preenchimento</div>
        <PaintEditor
          title="Preenchimento"
          testPrefix="vector-fill"
          paint={first.fill}
          onPaint={(p) => void applyPaint(nodes, { fill: p })}
        />
        <div className="prop-subhead">Traço</div>
        <PaintEditor
          title="Traço"
          testPrefix="vector-stroke"
          paint={first.stroke}
          onPaint={(p) => void applyPaint(nodes, { stroke: p })}
        />
        {strokeMode !== 'none' && (
          <>
            <Row label="Largura">
              <div className="vec-tid" data-testid="vector-stroke-width">
                <NumberInput
                  label="W"
                  title="Largura do traço"
                  unit=""
                  min={0}
                  step={0.5}
                  value={first.strokeWidth === undefined ? undefined : String(first.strokeWidth)}
                  placeholder="1"
                  onCommit={(v) => {
                    const n = Number(v);
                    if (v === '') void applyPaint(nodes, { strokeWidth: null });
                    else if (Number.isFinite(n) && n >= 0)
                      void applyPaint(nodes, { strokeWidth: n });
                  }}
                />
              </div>
            </Row>
            <Row label="Ponta">
              <div className="vec-tid" data-testid="vector-stroke-cap">
                <SelectInput
                  value={first.strokeLinecap}
                  options={CAPS}
                  placeholder="butt"
                  title="Extremidades"
                  onChange={(v) =>
                    void applyPaint(nodes, {
                      strokeLinecap: (v || null) as VectorPath['strokeLinecap'] | null,
                    })
                  }
                />
              </div>
            </Row>
            <Row label="Junção">
              <div className="vec-tid" data-testid="vector-stroke-join">
                <SelectInput
                  value={first.strokeLinejoin}
                  options={JOINS}
                  placeholder="miter"
                  title="Junção"
                  onChange={(v) =>
                    void applyPaint(nodes, {
                      strokeLinejoin: (v || null) as VectorPath['strokeLinejoin'] | null,
                    })
                  }
                />
              </div>
            </Row>
            <Row label="Tracejado">
              <div className="vec-tid" data-testid="vector-stroke-dash">
                <TextInput
                  value={first.strokeDasharray}
                  placeholder="ex.: 4 2"
                  title="Tracejado (dasharray)"
                  monospace
                  onCommit={(v) => {
                    const t = v.trim();
                    if (t !== '' && !/^(?:none|[0-9eE.,+\-\s]+)$/.test(t)) {
                      ui.toast('Tracejado inválido: use números, ex.: 4 2', 'error');
                      return;
                    }
                    void applyPaint(nodes, {
                      strokeDasharray: t === '' || t === 'none' ? null : t,
                    });
                  }}
                />
              </div>
            </Row>
          </>
        )}
      </>
    );
  }
  return (
    <Section id="props-vector" title="Vetor">
      <Body>
        {body}
        {!locked && <Combine nodes={nodes} />}
      </Body>
    </Section>
  );
}
