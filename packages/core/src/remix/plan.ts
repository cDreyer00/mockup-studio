/**
 * Planejador do remix local: gera variações de um nó lado a lado (clones do frame raiz com uma
 * transformação aplicada). Puro e determinístico (mesma entrada, mesmas ops; os ids vêm de
 * `newId`, injetável nos testes). Todas as ops de um remix ficam numa lista só, para o chamador
 * aplicar numa única chamada (uma entrada de undo). O remix com IA (`ai`) fica no servidor.
 */
import { parseCssColor } from '../cssEval.js';
import { getComputedLike } from '../computed.js';
import { findNode, walk } from '../document.js';
import { newNodeId } from '../ids.js';
import type { Op, StyleChange } from '../ops.js';
import type { RemixKind } from '../protocol.js';
import type { Document, Node, NodeType } from '../types.js';
import { colorScale, COLOR_STOPS } from './color.js';
import { FONT_PAIRS, fontFamilyValue } from './fontPairs.js';

export interface PlanRemixOptions {
  /** Quantidade de variações (cada tipo tem seu padrão e seu máximo). */
  count?: number;
  /** Famílias de fonte disponíveis localmente (`font-pairs`); ausente = não filtra. */
  fonts?: string[];
  /** Gerador de ids dos nós clonados (padrão: `newNodeId`). */
  newId?: (type: NodeType) => string;
}

export interface RemixPlan {
  ops: Op[];
  /** Frames raiz criados, na ordem das variações. */
  frameIds: string[];
  /** Nome de cada variação, paralelo a `frameIds`. */
  labels: string[];
}

/** Espaço horizontal entre os frames lado a lado, em px. */
export const REMIX_GAP = 80;
/** Medida usada quando o frame não tem largura/altura em px. */
const DEFAULT_FRAME_SIZE = 400;

/** Edição de estilo e reordenação, descritas pelos ids ORIGINAIS (traduzidos para o clone depois). */
interface Variation {
  label: string;
  styles: { nodeId: string; set?: Record<string, string>; unset?: string[] }[];
  reorder?: { parentId: string; childIds: string[] };
}

const px = (v: string | undefined): number | undefined => {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))px\s*$/i.exec(v ?? '');
  return m ? Number(m[1]) : undefined;
};

const positive = (n: number | undefined): n is number => n !== undefined && n > 0;

function checkCount(count: number | undefined, def: number, max: number): number {
  if (count === undefined) return Math.min(def, max);
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`count inválido (${String(count)}): use um inteiro a partir de 1.`);
  return Math.min(count, max);
}

/* ---------------- color-scale ---------------- */

const COLOR_PROPS = ['background-color', 'background', 'color', 'border-color', 'fill'] as const;

/** Índices espaçados de `count` itens entre `total` (1 item = o do meio, o stop 500). */
function spacedIndexes(count: number, total: number): number[] {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  if (count === 1) return [Math.min(5, total - 1)];
  return Array.from({ length: count }, (_, k) => Math.round((k * (total - 1)) / (count - 1)));
}

function planColorScale(doc: Document, node: Node, count: number | undefined): Variation[] {
  const computed = getComputedLike(doc, node.id);
  let found: { prop: string; value: string } | undefined;
  for (const prop of COLOR_PROPS) {
    if (!(prop in node.style)) continue;
    const value = computed[prop];
    const rgba = value ? parseCssColor(value) : null;
    if (value && rgba && rgba.a === 1) {
      found = { prop, value };
      break;
    }
  }
  if (!found)
    throw new Error(
      'O nó não tem cor sólida (background-color, background, color, border-color ou fill) para gerar a escala de tons. Escolha um nó com cor definida em hex, rgb(), hsl() ou token.',
    );
  const { prop, value } = found;
  const scale = colorScale(value);
  const n = checkCount(count, COLOR_STOPS.length, COLOR_STOPS.length);
  return spacedIndexes(n, scale.length).map((i) => ({
    label: `tom ${scale[i]!.stop}`,
    styles: [{ nodeId: node.id, set: { [prop]: scale[i]!.color } }],
  }));
}

/* ---------------- font-pairs ---------------- */

const isHeadingTag = (tag: string): boolean => /^h[1-6]$/i.test(tag);

function fontSizePx(v: string | undefined): number | undefined {
  const rem = /^\s*(\d*\.?\d+)rem\s*$/i.exec(v ?? '');
  return rem ? Number(rem[1]) * 16 : px(v);
}

function fontWeightOf(v: string | undefined): number | undefined {
  if (!v) return undefined;
  if (/^(bold|bolder)$/i.test(v.trim())) return 700;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const hasText = (n: Node): boolean => typeof n.text === 'string' && n.text.trim() !== '';

function planFontPairs(
  doc: Document,
  node: Node,
  ancestors: Node[],
  count: number | undefined,
  fonts: string[] | undefined,
): Variation[] {
  const available = fonts ? new Set(fonts.map((f) => f.trim().toLowerCase())) : undefined;
  const pairs = FONT_PAIRS.filter(
    (p) =>
      !available || (available.has(p.heading.toLowerCase()) && available.has(p.body.toLowerCase())),
  );
  if (pairs.length === 0)
    throw new Error(
      'Nenhum par de fontes da lista curada tem as duas famílias disponíveis. Instale ou embuta fontes (ex.: Inter, Playfair Display) com add_font e tente de novo.',
    );
  const n = checkCount(count, 4, pairs.length);

  // Quem recebe a fonte: a raiz e os nós com texto; título = h1–h6, fonte >= 24px ou peso >= 600.
  const targets: { nodeId: string; heading: boolean }[] = [];
  let anyText = false;
  const visit = (cur: Node, tagHeading: boolean): void => {
    const byTag = tagHeading || isHeadingTag(cur.tag);
    if (hasText(cur)) anyText = true;
    if (cur === node || hasText(cur)) {
      let heading = byTag;
      if (!heading) {
        const c = getComputedLike(doc, cur.id);
        const size = fontSizePx(c['font-size']);
        const weight = fontWeightOf(c['font-weight']);
        heading = (size !== undefined && size >= 24) || (weight !== undefined && weight >= 600);
      }
      targets.push({ nodeId: cur.id, heading });
    }
    for (const child of cur.children) visit(child, byTag);
  };
  visit(
    node,
    ancestors.some((a) => isHeadingTag(a.tag)),
  );
  if (!anyText) throw new Error('O nó não tem texto para trocar a fonte.');

  return pairs.slice(0, n).map((p) => ({
    label: `${p.heading} + ${p.body}`,
    styles: targets.map((t) => ({
      nodeId: t.nodeId,
      set: { 'font-family': fontFamilyValue(t.heading ? p.heading : p.body) },
    })),
  }));
}

/* ---------------- spacing ---------------- */

const SPACING_PROPS = new Set([
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-inline',
  'padding-block',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-inline',
  'margin-block',
  'gap',
  'row-gap',
  'column-gap',
]);

/** Arredonda à grade sem zerar valores positivos (mantém o sinal de margens negativas). */
function snap(v: number, grid: number): number {
  const abs = Math.abs(v);
  const r = Math.round(abs / grid) * grid;
  return Math.sign(v) * (r === 0 && abs > 0 ? grid : r);
}

const SPACING_VARIATIONS: { label: string; fn: (v: number) => number }[] = [
  { label: 'compacto', fn: (v) => snap(v * 0.5, 4) },
  { label: 'grade 4', fn: (v) => snap(v, 4) },
  { label: 'grade 8', fn: (v) => snap(v, 8) },
  { label: 'confortável', fn: (v) => snap(v * 1.5, 8) },
  { label: 'espaçoso', fn: (v) => snap(v * 2, 8) },
];

const formatPx = (n: number): string => `${+n.toFixed(2)}px`;

function planSpacing(doc: Document, node: Node, count: number | undefined): Variation[] {
  const entries: { nodeId: string; prop: string; raw: string; tokens: string[] }[] = [];
  walk(node, (cur) => {
    const props = Object.keys(cur.style).filter((p) => SPACING_PROPS.has(p));
    if (props.length === 0) return;
    const computed = getComputedLike(doc, cur.id);
    for (const prop of props) {
      const value = (computed[prop] ?? '').trim();
      if (!value || value.includes('(')) continue;
      const tokens = value.split(/\s+/);
      if (tokens.some((t) => px(t) !== undefined && px(t) !== 0))
        entries.push({ nodeId: cur.id, prop, raw: cur.style[prop]!, tokens });
    }
  });
  if (entries.length === 0)
    throw new Error(
      'O nó não tem espaçamento em px (padding, margin, gap) para variar. Defina valores como "16px" no nó ou nos filhos.',
    );
  const n = checkCount(count, 4, SPACING_VARIATIONS.length);
  return SPACING_VARIATIONS.slice(0, n).map(({ label, fn }) => ({
    label,
    styles: entries.flatMap((e) => {
      const value = e.tokens
        .map((t) => {
          const v = px(t);
          return v === undefined ? t : formatPx(fn(v));
        })
        .join(' ');
      return value === e.raw ? [] : [{ nodeId: e.nodeId, set: { [e.prop]: value } }];
    }),
  }));
}

/* ---------------- layout ---------------- */

const isFlex = (n: Node): boolean =>
  n.type !== 'instance' && /^(inline-)?flex$/i.test((n.style['display'] ?? '').trim());

/** `justify-content` → `align-items` ao trocar os eixos (`undefined` = remover). */
function justifyToAlign(j: string | undefined): string | undefined {
  switch (j?.trim()) {
    case 'flex-start':
    case 'start':
    case 'left':
      return 'flex-start';
    case 'flex-end':
    case 'end':
    case 'right':
      return 'flex-end';
    case 'center':
      return 'center';
    case 'space-between':
    case 'space-around':
    case 'space-evenly':
      return 'stretch';
    default:
      return undefined;
  }
}

/** `align-items` → `justify-content` ao trocar os eixos (`undefined` = remover). */
function alignToJustify(a: string | undefined): string | undefined {
  switch (a?.trim()) {
    case 'flex-start':
    case 'start':
    case 'self-start':
      return 'flex-start';
    case 'flex-end':
    case 'end':
    case 'self-end':
      return 'flex-end';
    case 'center':
      return 'center';
    default:
      return undefined;
  }
}

function flexDirection(style: Record<string, string>): string {
  const own = style['flex-direction']?.trim();
  if (own) return own;
  const first = style['flex-flow']?.trim().split(/\s+/)[0];
  return first && /^(row|column)(-reverse)?$/.test(first) ? first : 'row';
}

function planLayout(node: Node, ancestors: Node[], count: number | undefined): Variation[] {
  const container = [node, ...[...ancestors].reverse()].find(isFlex);
  if (!container)
    throw new Error(
      'Nem o nó nem seus ancestrais usam flex (display: flex). O remix de layout só rearranja containers flex.',
    );
  const style = container.style;
  const dir = flexDirection(style);
  const flow = 'flex-flow' in style ? ['flex-flow'] : [];

  const variations: Variation[] = [];
  const newAlign = justifyToAlign(style['justify-content']);
  const newJustify = alignToJustify(style['align-items']);
  variations.push({
    label: 'direção invertida',
    styles: [
      {
        nodeId: container.id,
        set: {
          'flex-direction': dir.startsWith('column') ? 'row' : 'column',
          ...(newAlign ? { 'align-items': newAlign } : {}),
          ...(newJustify ? { 'justify-content': newJustify } : {}),
        },
        unset: [
          ...flow,
          ...(!newAlign && 'align-items' in style ? ['align-items'] : []),
          ...(!newJustify && 'justify-content' in style ? ['justify-content'] : []),
        ],
      },
    ],
  });
  // Com menos de 2 filhos a ordem invertida seria um clone idêntico: fica de fora.
  if (container.children.length >= 2) {
    variations.push({
      label: 'ordem invertida',
      styles: [],
      reorder: {
        parentId: container.id,
        childIds: [...container.children].reverse().map((c) => c.id),
      },
    });
  }
  variations.push({
    label: 'centralizado com quebra',
    styles: [
      {
        nodeId: container.id,
        set: {
          'flex-direction': dir,
          'flex-wrap': 'wrap',
          'justify-content': 'center',
          'align-items': 'center',
        },
        unset: flow,
      },
    ],
  });
  return variations.slice(0, checkCount(count, 3, 3));
}

/* ---------------- montagem ---------------- */

function frameSize(frame: Node): { w: number; h: number } {
  const s = frame.style;
  const w = px(s['width']);
  const h = px(s['height']) ?? px(s['min-height']);
  return { w: positive(w) ? w : DEFAULT_FRAME_SIZE, h: positive(h) ? h : DEFAULT_FRAME_SIZE };
}

/**
 * Cria variações do frame raiz que contém `nodeId`, lado a lado à direita, aplicando a
 * transformação de `kind` ao nó correspondente em cada clone. Lança `Error` (mensagem em
 * português) para nó inexistente/virtual, ou quando o tipo não se aplica ao nó (sem cor, sem
 * flex, sem espaçamento, sem texto). `ai` não é local: veja `RemixService`.
 */
export function planRemix(
  doc: Document,
  nodeId: string,
  kind: RemixKind,
  opts: PlanRemixOptions = {},
): RemixPlan {
  if (kind === 'ai')
    throw new Error('O remix com IA é executado pelo assistente (kind "ai"), não por planRemix.');
  if (nodeId.includes('/'))
    throw new Error(
      `O nó "${nodeId}" está dentro de uma instância de componente e não pode ser remixado. Edite o componente principal ou escolha um nó real.`,
    );
  const path = findNode(doc, nodeId);
  if (!path)
    throw new Error(
      `Nó não encontrado: "${nodeId}". Use get_basic_info ou get_tree_summary para ver os ids.`,
    );
  const node = path.node;
  const frame = path.ancestors[0] ?? node;

  let variations: Variation[];
  switch (kind) {
    case 'color-scale':
      variations = planColorScale(doc, node, opts.count);
      break;
    case 'font-pairs':
      variations = planFontPairs(doc, node, path.ancestors, opts.count, opts.fonts);
      break;
    case 'spacing':
      variations = planSpacing(doc, node, opts.count);
      break;
    case 'layout':
      variations = planLayout(node, path.ancestors, opts.count);
      break;
    default:
      throw new Error(`Tipo de remix desconhecido: "${String(kind)}".`);
  }

  // Posição: depois do frame mais à direita que se sobrepõe verticalmente ao de origem.
  const { w, h } = frameSize(frame);
  const y = frame.position?.y ?? 0;
  let right = (frame.position?.x ?? 0) + w;
  for (const other of path.page.frames) {
    const o = frameSize(other);
    const oy = other.position?.y ?? 0;
    if (oy < y + h && y < oy + o.h) right = Math.max(right, (other.position?.x ?? 0) + o.w);
  }
  const startX = right + REMIX_GAP;

  const newId = opts.newId ?? newNodeId;
  const subtree: Node[] = [];
  walk(frame, (n) => {
    subtree.push(n);
  });
  const indexOf = new Map(subtree.map((n, i) => [n.id, i]));

  const ops: Op[] = [];
  const frameIds: string[] = [];
  const labels: string[] = [];
  const rename: { nodeId: string; name: string }[] = [];
  const positions: { nodeId: string; position: { x: number; y: number } }[] = [];
  const styleChanges: StyleChange[] = [];
  const moves: Op[] = [];

  // Cada clone é duplicado do anterior (o primeiro, do original): a ordem das camadas fica natural.
  let sourceIds = subtree.map((n) => n.id);
  variations.forEach((v, i) => {
    const cloneIds = subtree.map((n) => newId(n.type));
    const idMap = Object.fromEntries(sourceIds.map((id, k) => [id, cloneIds[k]!]));
    ops.push({ type: 'duplicateNodes', nodeIds: [sourceIds[0]!], idMap });
    sourceIds = cloneIds;

    const cid = (orig: string): string => cloneIds[indexOf.get(orig)!]!;
    const rootId = cloneIds[0]!;
    frameIds.push(rootId);
    labels.push(v.label);
    rename.push({ nodeId: rootId, name: `${frame.name} — ${v.label}` });
    positions.push({ nodeId: rootId, position: { x: startX + i * (w + REMIX_GAP), y } });
    for (const s of v.styles) {
      styleChanges.push({
        nodeId: cid(s.nodeId),
        ...(s.set ? { set: s.set } : {}),
        ...(s.unset?.length ? { unset: s.unset } : {}),
      });
    }
    if (v.reorder) {
      moves.push({
        type: 'moveNodes',
        nodeIds: v.reorder.childIds.map(cid),
        parentId: cid(v.reorder.parentId),
        index: 0,
      });
    }
  });

  ops.push({ type: 'renameNodes', changes: rename });
  ops.push({ type: 'setPosition', changes: positions });
  if (styleChanges.length) ops.push({ type: 'updateStyles', changes: styleChanges });
  ops.push(...moves);
  return { ops, frameIds, labels };
}
