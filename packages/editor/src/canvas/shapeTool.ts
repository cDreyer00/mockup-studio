/**
 * Ferramentas de forma (Elipse, Linha, Polígono): retângulo/linha de arrasto, vetor da forma e
 * nó svg posicionado como o Container (pai sob o ponteiro; absoluto em pai bloco, no fluxo em flex).
 */
import { createShapeVector, createVectorNode, editVector } from '@mockup/core';
import type { Node, ShapeKind, ShapeSpec } from '@mockup/core';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { normalizeRect } from './geometry';
import type { Point, Rect } from './geometry';
import { constrainAngle } from './pen';
import { buildCreateOps, planPlacement } from './placement';
import type { Placement } from './placement';

export type ShapeTool = 'ellipse' | 'line' | 'polygon';

export const SHAPE_TOOLS: readonly ShapeTool[] = ['ellipse', 'line', 'polygon'];

export function isShapeTool(tool: string): tool is ShapeTool {
  return (SHAPE_TOOLS as readonly string[]).includes(tool);
}

/** Tamanho (px) de uma forma criada com um clique simples. */
export const DEFAULT_SHAPE_SIZE = { w: 100, h: 100 };
/** Número de pontas da estrela (polígono com Alt ao soltar). */
export const STAR_POINTS = 5;

const NAMES: Record<ShapeKind, string> = {
  rect: 'Retângulo',
  ellipse: 'Elipse',
  line: 'Linha',
  polygon: 'Polígono',
  star: 'Estrela',
};

/**
 * Retângulo de arrasto de `a` até `b` (mundo). Elipse e polígono com `shift` ficam quadrados
 * (proporção 1:1, seguindo o maior deslocamento); a linha com `shift` trava em múltiplos de 45°.
 */
export function shapeDragRect(tool: string, a: Point, b: Point, shift: boolean): Rect {
  if (!shift) return normalizeRect(a, b);
  if (tool === 'line') return normalizeRect(a, constrainAngle(a, b));
  if (tool === 'ellipse' || tool === 'polygon') {
    const d = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    return normalizeRect(a, {
      x: a.x + (b.x < a.x ? -d : d),
      y: a.y + (b.y < a.y ? -d : d),
    });
  }
  return normalizeRect(a, b);
}

/** Tipo de forma da ferramenta (polígono com `star` vira estrela). */
export function shapeKindOf(tool: ShapeTool, star: boolean): ShapeKind {
  return tool === 'polygon' && star ? 'star' : tool;
}

/** A linha foi desenhada da direita para a esquerda / de baixo para cima? */
export function lineFlips(start: Point, rect: Rect): { x: boolean; y: boolean } {
  return {
    x: rect.w > 0 && start.x >= rect.x + rect.w - 1e-6,
    y: rect.h > 0 && start.y >= rect.y + rect.h - 1e-6,
  };
}

const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/**
 * Nó svg da forma. `rect` é o retângulo desenhado (ou `null` para o tamanho padrão); `start` é o
 * ponto inicial do arrasto (define o sentido da linha). A caixa do nó segue o `viewBox` do vetor
 * (a linha tem folga para o traço), deslocada para o desenho ficar onde foi arrastado.
 */
export function buildShapeNode(
  tool: ShapeTool,
  rect: Rect | null,
  start: Point,
  plan: Pick<Placement, 'flow' | 'x' | 'y'>,
  opts: { star?: boolean } = {},
): Node {
  const kind = shapeKindOf(tool, !!opts.star);
  const w = rect ? Math.max(rect.w, kind === 'line' ? 0 : 1) : DEFAULT_SHAPE_SIZE.w;
  const h = rect
    ? Math.max(rect.h, kind === 'line' ? 0 : 1)
    : kind === 'line'
      ? 0
      : DEFAULT_SHAPE_SIZE.h;
  const spec: ShapeSpec = {
    kind,
    width: w,
    height: h,
    ...(kind === 'polygon' ? { sides: 3 } : {}),
    ...(kind === 'star' ? { points: STAR_POINTS } : {}),
  };
  let vector = createShapeVector(spec);
  if (kind === 'line' && rect) {
    const f = lineFlips(start, rect);
    if (f.x || f.y) {
      const sx = f.x ? w : 0;
      const sy = f.y ? h : 0;
      const d = `M ${sx} ${sy} L ${w - sx} ${h - sy}`;
      vector = editVector(vector, { paths: vector.paths.map((p, i) => (i === 0 ? { ...p, d } : p)) });
    }
  }
  const vb = vector.viewBox;
  const style: Record<string, string> = { width: px(vb.width), height: px(vb.height) };
  if (plan.flow) style.display = 'block';
  else {
    style.position = 'absolute';
    style.left = px(plan.x + vb.x);
    style.top = px(plan.y + vb.y);
  }
  return createVectorNode(vector, { name: NAMES[kind], style });
}

/**
 * Conclui o gesto de uma ferramenta de forma: coloca o nó como o Container (pai sob o ponteiro;
 * absoluto em pai bloco, no fluxo em pai flex), seleciona-o e volta para a ferramenta Selecionar.
 * Fora de um frame avisa (um svg não vira frame raiz sozinho).
 */
export async function createShape(
  tool: ShapeTool,
  start: Point,
  client: Point,
  rect: Rect | null,
  opts: { star?: boolean } = {},
): Promise<void> {
  const doc = useDoc.getState().doc;
  const pageId = currentPageId();
  if (!doc || !pageId) return;
  const at = rect ? { x: rect.x, y: rect.y } : start;
  const plan = planPlacement(doc, at, client);
  if (!plan.parentId) {
    ui.toast('Clique dentro de um frame para criar a forma', 'info');
    return;
  }
  const node = buildShapeNode(tool, rect, start, plan, opts);
  // Volta para seleção já (antes do ack), para não sobrescrever uma ferramenta escolhida no meio.
  if (useUi.getState().tool === tool) ui.setTool('select');
  const ack = await daemon.applySafe(buildCreateOps(pageId, plan, node));
  if (ack) ui.select([node.id]);
}
