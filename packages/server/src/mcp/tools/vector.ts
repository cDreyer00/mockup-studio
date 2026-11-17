import { z } from 'zod';
import {
  BOOLEAN_OPS,
  SHAPE_KINDS,
  buildBooleanOps,
  buildFlattenOps,
  buildSetVectorOps,
  createShapeVector,
  createVectorNode,
  ensureVector,
  findNode,
  fitVectorToContent,
  isFreeNode,
  nodeBoxInParent,
  normalizePathData,
  setVectorPaint,
  splitPaintStyles,
  svgToVector,
  vectorToSvg,
  editVector,
  type Box,
  type LayoutNode,
  type Op,
  type ShapeKind,
  type ShapeSpec,
  type Vector,
  type VectorPaint,
  type VectorPaintPatch,
} from '@mockup/core';
import { OutlineError, buildTextOutlineOps } from '../../outlines.js';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';
import { docWithNodes } from '../../component-view.js';

const stylesField = z.record(z.string(), z.string());

const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** Executa um builder do core e troca `Error` cru por `ToolError` com a mesma mensagem. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(e instanceof Error ? e.message : String(e));
  }
}

const shorten = (s: string, max = 60): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function paintText(p: VectorPaint | undefined): string {
  if (p === undefined) return '-';
  if (typeof p === 'string') return p;
  return `gradiente ${p.type === 'linear' ? 'linear' : 'radial'} (${p.stops.length} cores)`;
}

/** Uma linha por path: id, d encurtado e tinta. */
function pathsSummary(v: Vector): string[] {
  return v.paths.map(
    (p) =>
      `- ${p.id}: d="${shorten(p.d)}" fill=${paintText(p.fill)} stroke=${paintText(p.stroke)}${
        p.strokeWidth !== undefined ? ` strokeWidth=${p.strokeWidth}` : ''
      }`,
  );
}

const gradientField = z
  .object({
    type: z.enum(['linear', 'radial']).describe('"linear" ou "radial".'),
    stops: z
      .array(
        z.object({
          offset: z.number().min(0).max(1).describe('Posição da cor, de 0 a 1, ex.: 0.5.'),
          color: z.string().describe('Cor CSS, ex.: "#6c5ce7".'),
          opacity: z.number().min(0).max(1).optional().describe('Opacidade da cor, de 0 a 1.'),
        }),
      )
      .min(1)
      .describe('Cores do gradiente, ex.: [{ "offset": 0, "color": "#f00" }, { "offset": 1, "color": "#00f" }].'),
    x1: z.number().optional().describe('Linear: início x (fração da caixa do path, padrão 0).'),
    y1: z.number().optional().describe('Linear: início y (padrão 0).'),
    x2: z.number().optional().describe('Linear: fim x (padrão 1).'),
    y2: z.number().optional().describe('Linear: fim y (padrão 0).'),
    cx: z.number().optional().describe('Radial: centro x (padrão 0.5).'),
    cy: z.number().optional().describe('Radial: centro y (padrão 0.5).'),
    r: z.number().min(0).optional().describe('Radial: raio (padrão 0.5).'),
  })
  .describe('Gradiente; coordenadas em fração da caixa do path.');

const paintField = z.union([z.string(), gradientField]);

/** Ferramentas de vetores: formas, paths, SVG, booleanas e texto em contornos. */
export function registerVectorTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf, opts } = ctx;

  const SHAPE_NAMES: Record<ShapeKind, string> = {
    rect: 'Retângulo',
    ellipse: 'Elipse',
    line: 'Linha',
    polygon: 'Polígono',
    star: 'Estrela',
  };

  tool(
    'create_shape',
    {
      title: 'Criar forma vetorial',
      description:
        'Cria uma forma (rect, ellipse, line, polygon, star) como nó svg editável. Com x/y fica absoluto (pai frame ou position:relative). Tinta (fill, stroke, stroke-width...) em styles vai para o vetor; o resto, para o nó. Padrão 100x100, fill #d9d9d9.',
      example: {
        parentId: 'fr_ab12cd34',
        shape: 'star',
        points: 5,
        x: 40,
        y: 40,
        width: 120,
        height: 120,
        styles: { fill: '#f5c518', stroke: '#111111', 'stroke-width': '2' },
      },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "fr_ab12cd34".'),
        shape: z
          .enum(SHAPE_KINDS as [ShapeKind, ...ShapeKind[]])
          .describe('Forma: "rect", "ellipse", "line", "polygon" ou "star".'),
        styles: stylesField
          .optional()
          .describe(
            'Estilos CSS: tinta (fill, stroke, stroke-width...) vai para o vetor, ex.: { "fill": "#6c5ce7", "stroke": "#111", "stroke-width": "2", "opacity": "0.8" }; o resto fica no nó.',
          ),
        x: z.number().optional().describe('Posição x (px) no pai; torna o nó absoluto, ex.: 40.'),
        y: z.number().optional().describe('Posição y (px) no pai; torna o nó absoluto, ex.: 40.'),
        width: z
          .number()
          .min(0)
          .optional()
          .describe('Largura em px, ex.: 120 (padrão 100). Linha: comprimento horizontal.'),
        height: z
          .number()
          .min(0)
          .optional()
          .describe('Altura em px, ex.: 120 (padrão 100; linha: 0, horizontal).'),
        cornerRadius: z
          .number()
          .min(0)
          .optional()
          .describe('rect: raio dos cantos em px, ex.: 12.'),
        sides: z
          .number()
          .int()
          .min(3)
          .max(64)
          .optional()
          .describe('polygon: número de lados, de 3 a 64, ex.: 6 (padrão 3).'),
        points: z
          .number()
          .int()
          .min(3)
          .max(64)
          .optional()
          .describe('star: número de pontas, de 3 a 64, ex.: 5 (padrão 5).'),
        innerRatio: z
          .number()
          .min(0.05)
          .max(0.95)
          .optional()
          .describe('star: raio interno / externo, de 0.05 a 0.95, ex.: 0.5 (padrão).'),
        name: z.string().optional().describe('Nome da camada, ex.: "Estrela".'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Posição entre os filhos, ex.: 0 (padrão: final).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({
      parentId,
      shape,
      styles,
      x,
      y,
      width,
      height,
      cornerRadius,
      sides,
      points,
      innerRatio,
      name,
      index,
      docId,
    }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const isLine = shape === 'line';
      const spec: ShapeSpec = {
        kind: shape,
        width: width ?? 100,
        height: height ?? (isLine ? 0 : 100),
        ...(cornerRadius !== undefined ? { cornerRadius } : {}),
        ...(sides !== undefined ? { sides } : {}),
        ...(points !== undefined ? { points } : {}),
        ...(innerRatio !== undefined ? { innerRatio } : {}),
      };
      const { paint, rest } = splitPaintStyles(styles ?? {});
      // opacidade é do vetor (tinta); o resto dos estilos fica no nó
      if (rest['opacity'] !== undefined) {
        const o = parseFloat(rest['opacity']);
        if (Number.isFinite(o) && o >= 0 && o <= 1) {
          paint.opacity = o;
          delete rest['opacity'];
        }
      }
      const vector = guard(() => createShapeVector(spec, paint));
      const vb = vector.viewBox;
      const style: Record<string, string> = { ...rest };
      if (style['width'] === undefined) style['width'] = px(vb.width);
      if (style['height'] === undefined) style['height'] = px(vb.height);
      if (x !== undefined || y !== undefined) {
        style['position'] = 'absolute';
        style['left'] = px((x ?? 0) + vb.x);
        style['top'] = px((y ?? 0) + vb.y);
      } else if (style['display'] === undefined) {
        style['display'] = 'block';
      }
      const node = createVectorNode(vector, { name: name ?? SHAPE_NAMES[shape], style });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'create_shape');
      const abs =
        style['position'] === 'absolute'
          ? ` Absoluto em (${x ?? 0}, ${y ?? 0}); o pai precisa ser frame ou ter position:relative.`
          : ' No fluxo do pai (passe x/y para posicionar de forma absoluta).';
      return `Forma "${shape}" criada: ${node.id} em ${parentId} (${style['width']} x ${style['height']}).${abs} Paths editáveis (p1); mude a tinta com set_vector_paint e o contorno com set_path.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'set_path',
    {
      title: 'Definir path de um vetor',
      description:
        'Troca o path data (d) de um path de um nó svg editável (valida M L H V C S Q T A Z). fit:true ajusta o viewBox ao conteúdo e a caixa do nó (left/top/width/height). Veja os ids com get_svg.',
      example: { nodeId: 'sv_ab12cd34', d: 'M 0 0 L 100 0 L 50 80 Z', fit: true },
      inputSchema: {
        nodeId: z.string().describe('Id do nó svg, ex.: "sv_ab12cd34".'),
        d: z.string().min(1).describe('Path data SVG, ex.: "M 0 0 L 100 0 L 50 80 Z".'),
        pathId: z
          .string()
          .optional()
          .describe(
            'Id do path a substituir, ex.: "p1" (obrigatório se o vetor tem vários paths; veja get_svg).',
          ),
        fit: z
          .boolean()
          .optional()
          .describe(
            'Ajusta o viewBox à caixa dos paths e a caixa do nó (left/top/width/height), ex.: true (padrão false).',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, d, pathId, fit, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const { node } = requireNode(doc, nodeId);
      if (node.type !== 'svg') {
        throw new ToolError(
          `O nó ${nodeId} é <${node.tag}>, não um svg. Use create_shape ou insert_svg para criar um vetor e depois set_path.`,
        );
      }
      let normalized: string;
      try {
        normalized = normalizePathData(d);
      } catch (e) {
        throw new ToolError(
          `Path data inválido: ${e instanceof Error ? e.message : String(e)}. Ex.: "M 0 0 L 100 0 L 50 80 Z".`,
        );
      }
      if (!normalized.trim() || !/[Mm]/.test(normalized)) {
        throw new ToolError('Path data vazio ou sem "M" inicial. Ex.: "M 0 0 L 100 0 L 50 80 Z".');
      }
      let vector = ensureVector(node);
      const notes: string[] = [];
      if (!vector) {
        const box = nodeBoxInParent(node);
        vector = {
          viewBox: { x: 0, y: 0, width: box?.width ?? 100, height: box?.height ?? 100 },
          paths: [{ id: 'p1', d: normalized, fill: '#d9d9d9' }],
        };
        notes.push('O nó não tinha vetor: criado um path "p1" com fill #d9d9d9.');
      } else {
        if (vector.paths.length === 0) {
          throw new ToolError(
            `O svg ${nodeId} foi importado com recursos que o modelo de paths não representa (filtros, máscaras, texto, opacidade parcial...) e não é editável. Use get_svg para ver o markup, apague o nó e recrie com insert_svg (SVG simplificado) ou create_shape.`,
          );
        }
        let target = pathId;
        if (target === undefined) {
          if (vector.paths.length > 1) {
            throw new ToolError(
              `O vetor tem ${vector.paths.length} paths (${vector.paths.map((p) => p.id).join(', ')}). Informe pathId, ex.: pathId "${vector.paths[0]!.id}".`,
            );
          }
          target = vector.paths[0]!.id;
        }
        if (!vector.paths.some((p) => p.id === target)) {
          throw new ToolError(
            `Path "${target}" não existe em ${nodeId}. Ids disponíveis: ${vector.paths.map((p) => p.id).join(', ')}.`,
          );
        }
        vector = editVector(vector, {
          paths: vector.paths.map((p) => (p.id === target ? { ...p, d: normalized } : p)),
        });
      }
      const ops: Op[] = [];
      if (fit) {
        const box = nodeBoxInParent(node);
        if (!box) {
          throw new ToolError(
            'fit exige width e height em px no nó (ou um viewBox). Defina com update_styles({ width: "120px", height: "120px" }) e tente de novo.',
          );
        }
        const fitted = guard(() => fitVectorToContent(vector!, box));
        vector = fitted.vector;
        const st: Record<string, string> = {
          width: px(fitted.box.width),
          height: px(fitted.box.height),
        };
        const pos = (node.style['position'] ?? '').trim();
        if (pos === 'absolute' || pos === 'fixed' || node.style['left'] || node.style['top']) {
          st['left'] = px(fitted.box.x);
          st['top'] = px(fitted.box.y);
        }
        ops.push(...buildSetVectorOps(nodeId, vector), { type: 'updateStyles', nodeIds: [nodeId], styles: st });
        notes.push(
          `viewBox ajustado ao conteúdo; caixa do nó: ${st['width']} x ${st['height']}${st['left'] ? ` em (${st['left']}, ${st['top']})` : ''}.`,
        );
      } else {
        ops.push(...buildSetVectorOps(nodeId, vector));
      }
      const r = apply(id, ops, 'set_path');
      return `Path atualizado em ${nodeId}: d="${shorten(normalized, 80)}".${notes.length ? ` ${notes.join(' ')}` : ''}\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'insert_svg',
    {
      title: 'Inserir SVG',
      description:
        'Insere markup SVG como nó svg, sanitizado e preservado (raw) até a primeira edição. SVG simples (path, formas, gradientes) fica com paths editáveis; a resposta avisa. Sem width/height usa o tamanho do SVG.',
      example: {
        parentId: 'fr_ab12cd34',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" fill="none" stroke="#111" stroke-width="2"/></svg>',
        width: 24,
        height: 24,
        name: 'Check',
      },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "fr_ab12cd34".'),
        svg: z
          .string()
          .min(1)
          .describe('Markup SVG completo, começando em <svg ...>, ex.: "<svg viewBox=\\"0 0 24 24\\">...</svg>".'),
        name: z.string().optional().describe('Nome da camada, ex.: "Logo".'),
        x: z.number().optional().describe('Posição x (px); torna o nó absoluto, ex.: 40.'),
        y: z.number().optional().describe('Posição y (px); torna o nó absoluto, ex.: 40.'),
        width: z.number().positive().optional().describe('Largura em px, ex.: 48.'),
        height: z.number().positive().optional().describe('Altura em px, ex.: 48.'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Posição entre os filhos, ex.: 0 (padrão: final).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ parentId, svg, name, x, y, width, height, index, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const vector = guard(() => svgToVector(svg));
      const vb = vector.viewBox;
      const ratio = vb.width / vb.height;
      let w = width;
      let h = height;
      if (w === undefined && h === undefined) {
        w = vb.width;
        h = vb.height;
      } else if (w === undefined) w = h! * ratio;
      else if (h === undefined) h = w / ratio;
      const style: Record<string, string> = { width: px(w!), height: px(h!) };
      if (x !== undefined || y !== undefined) {
        style['position'] = 'absolute';
        style['left'] = px(x ?? 0);
        style['top'] = px(y ?? 0);
      } else style['display'] = 'block';
      const node = createVectorNode(vector, { name: name ?? 'SVG', style });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_svg');
      const editable =
        vector.paths.length > 0
          ? `${vector.paths.length} path(s) editáveis (${vector.paths.map((p) => p.id).join(', ')}); o markup original foi preservado até a primeira edição.`
          : 'NÃO editável: o SVG usa recursos que o modelo de paths não representa (filtros, máscaras, clipPath, use, texto, imagem, opacidade de grupo, fill-opacity...). Ele é exibido e exportado como está; set_path, set_vector_paint, boolean_op e flatten não funcionam nele. Para editar, simplifique o SVG (só paths/formas com fill e stroke).';
      return `SVG inserido: ${node.id} em ${parentId} (${style['width']} x ${style['height']}, viewBox ${vb.x} ${vb.y} ${vb.width} ${vb.height}). ${editable}\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'get_svg',
    {
      title: 'Ler SVG de um nó',
      description:
        'Lê um nó svg: markup atual, viewBox e resumo dos paths (id, d, fill, stroke, strokeWidth), dizendo se o markup é o original (raw) ou regenerado. Somente leitura.',
      example: { nodeId: 'sv_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Id do nó svg, ex.: "sv_ab12cd34".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      const { node } = requireNode(store.get(id), nodeId);
      if (node.type !== 'svg' && !node.svg && !node.vector) {
        throw new ToolError(
          `O nó ${nodeId} é <${node.tag}>, não um svg. Use get_tree_summary para achar nós svg (ícones, formas, vetores).`,
        );
      }
      let vector: Vector | null = null;
      try {
        vector = ensureVector(node);
      } catch {
        vector = null;
      }
      const markup = node.vector ? vectorToSvg(node.vector) : (node.svg ?? '');
      const lines: string[] = [];
      let origin: string;
      if (!node.vector) {
        origin =
          'sem modelo vetorial salvo (svg legado, de write_html ou insert_icon); os paths abaixo são inferidos do markup e viram um vetor na primeira edição';
      } else if (node.vector.raw !== undefined) {
        origin = 'markup original preservado (raw); será regenerado na primeira edição dos paths';
      } else {
        origin = 'markup regenerado a partir dos paths';
      }
      lines.push(`${node.id} "${node.name ?? ''}" — ${origin}.`);
      if (vector) {
        const vb = vector.viewBox;
        lines.push(`viewBox: ${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
        if (vector.paths.length === 0) {
          lines.push(
            'Paths: nenhum editável (o SVG usa recursos que o modelo não representa; só o markup vale).',
          );
        } else {
          lines.push(`Paths (${vector.paths.length}):`, ...pathsSummary(vector));
        }
      } else {
        lines.push('Nó sem markup SVG.');
      }
      const MAX = 20_000;
      lines.push(
        '',
        markup.length > MAX
          ? `${markup.slice(0, MAX)}\n… (markup truncado: ${markup.length} caracteres no total)`
          : markup,
      );
      return lines.join('\n');
    },
  );

  tool(
    'set_vector_paint',
    {
      title: 'Definir preenchimento e traço',
      description:
        'Muda a tinta de paths de um nó svg: fill, stroke (cor, "none" ou gradiente linear/radial), strokeWidth, linecap, linejoin, dasharray, opacity. Sem pathIds vale para todos; "" remove. Regenera o markup.',
      example: {
        nodeId: 'sv_ab12cd34',
        fill: {
          type: 'linear',
          stops: [
            { offset: 0, color: '#6c5ce7' },
            { offset: 1, color: '#00cec9' },
          ],
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
        },
        stroke: '#111111',
        strokeWidth: 2,
      },
      inputSchema: {
        nodeId: z.string().describe('Id do nó svg, ex.: "sv_ab12cd34".'),
        pathIds: z
          .array(z.string())
          .optional()
          .describe('Ids dos paths a alterar, ex.: ["p1"] (padrão: todos; veja get_svg).'),
        fill: paintField
          .optional()
          .describe('Preenchimento: cor ("#6c5ce7", "none", "currentColor"), gradiente ou "" para remover.'),
        stroke: paintField
          .optional()
          .describe('Traço: cor, gradiente ou "" para remover, ex.: "#111111".'),
        strokeWidth: z.number().min(0).optional().describe('Espessura do traço em unidades do viewBox, ex.: 2.'),
        linecap: z.enum(['butt', 'round', 'square']).optional().describe('Pontas do traço, ex.: "round".'),
        linejoin: z.enum(['miter', 'round', 'bevel']).optional().describe('Junções do traço, ex.: "round".'),
        dasharray: z
          .string()
          .optional()
          .describe('Tracejado, ex.: "4 2"; "none" ou "" remove.'),
        opacity: z.number().min(0).max(1).optional().describe('Opacidade do path, de 0 a 1, ex.: 0.8.'),
        fillRule: z
          .enum(['nonzero', 'evenodd'])
          .optional()
          .describe('Regra de preenchimento, ex.: "evenodd" (vaza buracos em subpaths).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, pathIds, fill, stroke, strokeWidth, linecap, linejoin, dasharray, opacity, fillRule, docId }) => {
      const id = store.resolveDocId(docId);
      const { node } = requireNode(store.get(id), nodeId);
      if (node.type !== 'svg') {
        throw new ToolError(
          `O nó ${nodeId} é <${node.tag}>, não um svg. Para texto e caixas use update_styles (color, background).`,
        );
      }
      const vector = guard(() => ensureVector(node));
      if (!vector) throw new ToolError(`O nó ${nodeId} não tem markup SVG.`);
      if (vector.paths.length === 0) {
        throw new ToolError(
          `O svg ${nodeId} não tem paths editáveis (o SVG importado usa recursos como filtros, máscaras ou texto). Alternativas: set_attrs(nodeIds, { fill: "#hex" }) no <svg> raiz, ou recrie com insert_svg simplificado.`,
        );
      }
      const toPaint = (v: VectorPaint | undefined): VectorPaint | null | undefined =>
        v === undefined ? undefined : typeof v === 'string' && v.trim() === '' ? null : v;
      const patch: VectorPaintPatch = {};
      const f = toPaint(fill);
      const s = toPaint(stroke);
      if (f !== undefined) patch.fill = f;
      if (s !== undefined) patch.stroke = s;
      if (strokeWidth !== undefined) patch.strokeWidth = strokeWidth;
      if (linecap !== undefined) patch.strokeLinecap = linecap;
      if (linejoin !== undefined) patch.strokeLinejoin = linejoin;
      if (dasharray !== undefined)
        patch.strokeDasharray = dasharray.trim() === '' || dasharray.trim() === 'none' ? null : dasharray.trim();
      if (opacity !== undefined) patch.opacity = opacity;
      if (fillRule !== undefined) patch.fillRule = fillRule;
      if (Object.keys(patch).length === 0) {
        throw new ToolError(
          'Informe ao menos uma propriedade: fill, stroke, strokeWidth, linecap, linejoin, dasharray, opacity ou fillRule. Ex.: fill "#6c5ce7".',
        );
      }
      const next = guard(() => setVectorPaint(vector, patch, pathIds));
      const r = apply(id, buildSetVectorOps(nodeId, next), 'set_vector_paint');
      const changed = pathIds?.length ?? next.paths.length;
      return `Tinta atualizada em ${changed} path(s) de ${nodeId}; o markup foi regenerado.\n${pathsSummary(next).join('\n')}\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  /**
   * Caixas medidas (px, no padding box do pai) dos nós em fluxo, via motor de render: mede o pai e
   * subtrai a posição e a borda dele. Sem render ou com falha devolve só o que conseguiu; o core
   * então recusa o nó em fluxo com a mensagem clara.
   */
  async function flowBoxes(
    doc: Parameters<typeof findNode>[0],
    docId: string,
    nodeIds: string[],
  ): Promise<Record<string, Box>> {
    const boxes: Record<string, Box> = {};
    if (!opts.render) return boxes;
    const byParent = new Map<string, string[]>();
    for (const nid of nodeIds) {
      const f = findNode(doc, nid);
      if (!f?.parent || isFreeNode(f.node, false)) continue;
      byParent.set(f.parent.id, [...(byParent.get(f.parent.id) ?? []), nid]);
    }
    const px0 = (v: string | undefined): number => parseFloat(v ?? '') || 0;
    for (const [parentId, ids] of byParent) {
      let layout: LayoutNode;
      try {
        layout = await opts.render.measure({
          doc,
          docId,
          nodeId: parentId,
          assetsDir: store.assetsDir(docId),
        });
      } catch {
        continue;
      }
      const ox = layout.x + px0(layout.style['border-left-width']);
      const oy = layout.y + px0(layout.style['border-top-width']);
      for (const c of layout.children) {
        if (ids.includes(c.id)) boxes[c.id] = { x: c.x - ox, y: c.y - oy, width: c.width, height: c.height };
      }
    }
    return boxes;
  }

  tool(
    'boolean_op',
    {
      title: 'Operação booleana entre vetores',
      description:
        'Combina 2+ nós svg irmãos: union, subtract (o de baixo menos os de cima), intersect ou exclude. Curvas são achatadas. O resultado substitui o primeiro nó e os originais somem. Nós em fluxo precisam de render para medir a posição; sem ele, use position:absolute. Desfaça com undo.',
      example: { nodeIds: ['sv_aaaa1111', 'sv_bbbb2222'], op: 'subtract', name: 'Furo' },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(2)
          .describe('Ids de 2 ou mais nós svg irmãos (mesmo pai), ex.: ["sv_aaaa1111", "sv_bbbb2222"].'),
        op: z
          .enum(BOOLEAN_OPS as unknown as [string, ...string[]])
          .describe('Operação: "union", "subtract", "intersect" ou "exclude".'),
        name: z.string().optional().describe('Nome da camada do resultado, ex.: "Furo".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeIds, op, name, docId }) => {
      const id = store.resolveDocId(docId);
      // ids virtuais (dentro de instâncias): lê da visão expandida; as ops roteiam
      const doc = docWithNodes(store.get(id), nodeIds);
      for (const n of nodeIds) requireNode(doc, n);
      const boxes = await flowBoxes(doc, id, nodeIds);
      const built = guard(() =>
        buildBooleanOps(doc, nodeIds, op as (typeof BOOLEAN_OPS)[number], { name, boxes }),
      );
      const r = apply(id, built.ops, 'boolean_op');
      return `Booleana "${op}" aplicada em ${nodeIds.length} nós: resultado ${built.nodeId} (originais removidos; curvas achatadas). Tinta do resultado: a do primeiro path do nó mais ao fundo; ajuste com set_vector_paint.\n${summaryOf(r.doc, [built.nodeId])}`;
    },
  );

  tool(
    'flatten',
    {
      title: 'Achatar vetores',
      description:
        'Achata vetores. Um nó: junta os paths num só. Vários svgs irmãos: um nó só com os paths de todos (cada um com sua tinta). Nós em fluxo precisam de render para medir a posição; sem ele, use position:absolute. Desfaça com undo.',
      example: { nodeIds: ['sv_aaaa1111', 'sv_bbbb2222'] },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .describe('Ids de 1 ou mais nós svg (irmãos, se forem vários), ex.: ["sv_aaaa1111"].'),
        name: z.string().optional().describe('Nome da camada do resultado, ex.: "Ícone".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeIds, name, docId }) => {
      const id = store.resolveDocId(docId);
      // ids virtuais (dentro de instâncias): lê da visão expandida; as ops roteiam
      const doc = docWithNodes(store.get(id), nodeIds);
      for (const n of nodeIds) requireNode(doc, n);
      const boxes = await flowBoxes(doc, id, nodeIds);
      const built = guard(() => buildFlattenOps(doc, nodeIds, { name, boxes }));
      const r = apply(id, built.ops, 'flatten');
      return `${nodeIds.length} nó(s) achatado(s) em ${built.nodeId}.\n${summaryOf(r.doc, [built.nodeId])}`;
    },
  );

  tool(
    'text_to_outlines',
    {
      title: 'Texto em contornos',
      description:
        'Converte nós de texto em svg com os contornos dos glifos (fonte do documento ou do sistema); deixa de ser texto editável. Devolve notas (fonte, quebras, glifos ausentes). Desfaça com undo.',
      example: { nodeIds: ['tx_ab12cd34'] },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .optional()
          .describe('Ids dos nós de texto, ex.: ["tx_ab12cd34"].'),
        nodeId: z.string().optional().describe('Atalho para um só nó, ex.: "tx_ab12cd34".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeIds, nodeId, docId }) => {
      const ids = [...(nodeIds ?? []), ...(nodeId ? [nodeId] : [])];
      if (ids.length === 0) {
        throw new ToolError('Informe nodeIds (ou nodeId). Ex.: nodeIds ["tx_ab12cd34"].');
      }
      const id = store.resolveDocId(docId);
      const doc = docWithNodes(store.get(id), ids);
      for (const n of ids) requireNode(doc, n);
      let res;
      try {
        res = await buildTextOutlineOps({
          doc,
          docId: id,
          nodeIds: ids,
          assetsDir: store.assetsDir(id),
          render: opts.render,
        });
      } catch (e) {
        if (e instanceof OutlineError) throw new ToolError(e.message);
        throw e;
      }
      const r = apply(id, res.ops, 'text_to_outlines');
      const notes = res.notes.length ? `\nNotas:\n${res.notes.map((n) => `- ${n}`).join('\n')}` : '';
      return `${res.nodeIds.length} texto(s) convertido(s) em contornos: ${res.nodeIds.join(', ')}.${notes}\n${summaryOf(r.doc, res.nodeIds)}`;
    },
  );
}

