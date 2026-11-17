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

/** Runs a core builder and turns a raw `Error` into a `ToolError` with the same message. */
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
  return `${p.type === 'linear' ? 'linear' : 'radial'} gradient (${p.stops.length} colors)`;
}

/** One line per path: id, shortened d and paint. */
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
    type: z.enum(['linear', 'radial']).describe('"linear" or "radial".'),
    stops: z
      .array(
        z.object({
          offset: z.number().min(0).max(1).describe('Color position, from 0 to 1, e.g. 0.5.'),
          color: z.string().describe('CSS color, e.g. "#6c5ce7".'),
          opacity: z.number().min(0).max(1).optional().describe('Color opacity, from 0 to 1.'),
        }),
      )
      .min(1)
      .describe(
        'Gradient color stops, e.g. [{ "offset": 0, "color": "#f00" }, { "offset": 1, "color": "#00f" }].',
      ),
    x1: z.number().optional().describe('Linear: start x (fraction of the path box, default 0).'),
    y1: z.number().optional().describe('Linear: start y (default 0).'),
    x2: z.number().optional().describe('Linear: end x (default 1).'),
    y2: z.number().optional().describe('Linear: end y (default 0).'),
    cx: z.number().optional().describe('Radial: center x (default 0.5).'),
    cy: z.number().optional().describe('Radial: center y (default 0.5).'),
    r: z.number().min(0).optional().describe('Radial: radius (default 0.5).'),
  })
  .describe('Gradient; coordinates as a fraction of the path box.');

const paintField = z.union([z.string(), gradientField]);

/** Vector tools: shapes, paths, SVG, boolean ops and text outlines. */
export function registerVectorTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf, opts } = ctx;

  const SHAPE_NAMES: Record<ShapeKind, string> = {
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    line: 'Line',
    polygon: 'Polygon',
    star: 'Star',
  };

  tool(
    'create_shape',
    {
      title: 'Create vector shape',
      description:
        'Creates a shape (rect, ellipse, line, polygon, star) as an editable svg node. With x/y it is absolute (parent frame or position:relative). Paint (fill, stroke, stroke-width...) in styles goes to the vector; the rest goes to the node. Default 100x100, fill #d9d9d9.',
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
        parentId: z.string().describe('Parent id, e.g. "fr_ab12cd34".'),
        shape: z
          .enum(SHAPE_KINDS as [ShapeKind, ...ShapeKind[]])
          .describe('Shape: "rect", "ellipse", "line", "polygon" or "star".'),
        styles: stylesField
          .optional()
          .describe(
            'CSS styles: paint (fill, stroke, stroke-width...) goes to the vector, e.g. { "fill": "#6c5ce7", "stroke": "#111", "stroke-width": "2", "opacity": "0.8" }; the rest stays on the node.',
          ),
        x: z
          .number()
          .optional()
          .describe('X position (px) in the parent; makes the node absolute, e.g. 40.'),
        y: z
          .number()
          .optional()
          .describe('Y position (px) in the parent; makes the node absolute, e.g. 40.'),
        width: z
          .number()
          .min(0)
          .optional()
          .describe('Width in px, e.g. 120 (default 100). Line: horizontal length.'),
        height: z
          .number()
          .min(0)
          .optional()
          .describe('Height in px, e.g. 120 (default 100; line: 0, horizontal).'),
        cornerRadius: z.number().min(0).optional().describe('rect: corner radius in px, e.g. 12.'),
        sides: z
          .number()
          .int()
          .min(3)
          .max(64)
          .optional()
          .describe('polygon: number of sides, from 3 to 64, e.g. 6 (default 3).'),
        points: z
          .number()
          .int()
          .min(3)
          .max(64)
          .optional()
          .describe('star: number of points, from 3 to 64, e.g. 5 (default 5).'),
        innerRatio: z
          .number()
          .min(0.05)
          .max(0.95)
          .optional()
          .describe('star: inner / outer radius, from 0.05 to 0.95, e.g. 0.5 (default).'),
        name: z.string().optional().describe('Layer name, e.g. "Star".'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Position among the children, e.g. 0 (default: end).'),
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
      // opacity belongs to the vector (paint); the rest of the styles stay on the node
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
          ? ` Absolute at (${x ?? 0}, ${y ?? 0}); the parent must be a frame or have position:relative.`
          : ' In the parent flow (pass x/y to position it absolutely).';
      return `Shape "${shape}" created: ${node.id} in ${parentId} (${style['width']} x ${style['height']}).${abs} Editable paths (p1); change the paint with set_vector_paint and the outline with set_path.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'set_path',
    {
      title: 'Set vector path',
      description:
        'Replaces the path data (d) of a path in an editable svg node (validates M L H V C S Q T A Z). fit:true fits the viewBox to the content and the node box (left/top/width/height). See the ids with get_svg.',
      example: { nodeId: 'sv_ab12cd34', d: 'M 0 0 L 100 0 L 50 80 Z', fit: true },
      inputSchema: {
        nodeId: z.string().describe('Id of the svg node, e.g. "sv_ab12cd34".'),
        d: z.string().min(1).describe('SVG path data, e.g. "M 0 0 L 100 0 L 50 80 Z".'),
        pathId: z
          .string()
          .optional()
          .describe(
            'Id of the path to replace, e.g. "p1" (required if the vector has several paths; see get_svg).',
          ),
        fit: z
          .boolean()
          .optional()
          .describe(
            'Fits the viewBox to the paths box and the node box (left/top/width/height), e.g. true (default false).',
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
          `Node ${nodeId} is <${node.tag}>, not an svg. Use create_shape or insert_svg to create a vector, then set_path.`,
        );
      }
      let normalized: string;
      try {
        normalized = normalizePathData(d);
      } catch (e) {
        throw new ToolError(
          `Invalid path data: ${e instanceof Error ? e.message : String(e)}. Ex.: "M 0 0 L 100 0 L 50 80 Z".`,
        );
      }
      if (!normalized.trim() || !/[Mm]/.test(normalized)) {
        throw new ToolError(
          'Path data is empty or has no initial "M". E.g. "M 0 0 L 100 0 L 50 80 Z".',
        );
      }
      let vector = ensureVector(node);
      const notes: string[] = [];
      if (!vector) {
        const box = nodeBoxInParent(node);
        vector = {
          viewBox: { x: 0, y: 0, width: box?.width ?? 100, height: box?.height ?? 100 },
          paths: [{ id: 'p1', d: normalized, fill: '#d9d9d9' }],
        };
        notes.push('The node had no vector: created a path "p1" with fill #d9d9d9.');
      } else {
        if (vector.paths.length === 0) {
          throw new ToolError(
            `Svg ${nodeId} was imported with features the path model cannot represent (filters, masks, text, partial opacity...) and is not editable. Use get_svg to see the markup, delete the node and recreate it with insert_svg (simplified SVG) or create_shape.`,
          );
        }
        let target = pathId;
        if (target === undefined) {
          if (vector.paths.length > 1) {
            throw new ToolError(
              `The vector has ${vector.paths.length} paths (${vector.paths.map((p) => p.id).join(', ')}). Provide pathId, e.g. pathId "${vector.paths[0]!.id}".`,
            );
          }
          target = vector.paths[0]!.id;
        }
        if (!vector.paths.some((p) => p.id === target)) {
          throw new ToolError(
            `Path "${target}" does not exist in ${nodeId}. Available ids: ${vector.paths.map((p) => p.id).join(', ')}.`,
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
            'fit requires width and height in px on the node (or a viewBox). Set them with update_styles({ width: "120px", height: "120px" }) and try again.',
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
        ops.push(...buildSetVectorOps(nodeId, vector), {
          type: 'updateStyles',
          nodeIds: [nodeId],
          styles: st,
        });
        notes.push(
          `viewBox fitted to the content; node box: ${st['width']} x ${st['height']}${st['left'] ? ` at (${st['left']}, ${st['top']})` : ''}.`,
        );
      } else {
        ops.push(...buildSetVectorOps(nodeId, vector));
      }
      const r = apply(id, ops, 'set_path');
      return `Path updated in ${nodeId}: d="${shorten(normalized, 80)}".${notes.length ? ` ${notes.join(' ')}` : ''}\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'insert_svg',
    {
      title: 'Insert SVG',
      description:
        'Inserts SVG markup as an svg node, sanitized and preserved (raw) until the first edit. Simple SVG (path, shapes, gradients) gets editable paths; the response says so. Without width/height it uses the SVG size.',
      example: {
        parentId: 'fr_ab12cd34',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" fill="none" stroke="#111" stroke-width="2"/></svg>',
        width: 24,
        height: 24,
        name: 'Check',
      },
      inputSchema: {
        parentId: z.string().describe('Parent id, e.g. "fr_ab12cd34".'),
        svg: z
          .string()
          .min(1)
          .describe(
            'Complete SVG markup, starting at <svg ...>, e.g. "<svg viewBox=\\"0 0 24 24\\">...</svg>".',
          ),
        name: z.string().optional().describe('Layer name, e.g. "Logo".'),
        x: z.number().optional().describe('X position (px); makes the node absolute, e.g. 40.'),
        y: z.number().optional().describe('Y position (px); makes the node absolute, e.g. 40.'),
        width: z.number().positive().optional().describe('Width in px, e.g. 48.'),
        height: z.number().positive().optional().describe('Height in px, e.g. 48.'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Position among the children, e.g. 0 (default: end).'),
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
          ? `${vector.paths.length} editable path(s) (${vector.paths.map((p) => p.id).join(', ')}); the original markup was preserved until the first edit.`
          : 'NOT editable: the SVG uses features the path model cannot represent (filters, masks, clipPath, use, text, image, group opacity, fill-opacity...). It is displayed and exported as is; set_path, set_vector_paint, boolean_op and flatten do not work on it. To edit it, simplify the SVG (only paths/shapes with fill and stroke).';
      return `SVG inserted: ${node.id} in ${parentId} (${style['width']} x ${style['height']}, viewBox ${vb.x} ${vb.y} ${vb.width} ${vb.height}). ${editable}\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'get_svg',
    {
      title: 'Read a node SVG',
      description:
        'Reads an svg node: current markup, viewBox and a summary of the paths (id, d, fill, stroke, strokeWidth), saying whether the markup is the original (raw) or regenerated. Read-only.',
      example: { nodeId: 'sv_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Id of the svg node, e.g. "sv_ab12cd34".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      const { node } = requireNode(store.get(id), nodeId);
      if (node.type !== 'svg' && !node.svg && !node.vector) {
        throw new ToolError(
          `Node ${nodeId} is <${node.tag}>, not an svg. Use get_tree_summary to find svg nodes (icons, shapes, vectors).`,
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
          'no saved vector model (legacy svg, from write_html or insert_icon); the paths below are inferred from the markup and become a vector on the first edit';
      } else if (node.vector.raw !== undefined) {
        origin = 'original markup preserved (raw); will be regenerated on the first path edit';
      } else {
        origin = 'markup regenerated from the paths';
      }
      lines.push(`${node.id} "${node.name ?? ''}" — ${origin}.`);
      if (vector) {
        const vb = vector.viewBox;
        lines.push(`viewBox: ${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
        if (vector.paths.length === 0) {
          lines.push(
            'Paths: none editable (the SVG uses features the model cannot represent; only the markup counts).',
          );
        } else {
          lines.push(`Paths (${vector.paths.length}):`, ...pathsSummary(vector));
        }
      } else {
        lines.push('Node has no SVG markup.');
      }
      const MAX = 20_000;
      lines.push(
        '',
        markup.length > MAX
          ? `${markup.slice(0, MAX)}\n… (markup truncated: ${markup.length} characters in total)`
          : markup,
      );
      return lines.join('\n');
    },
  );

  tool(
    'set_vector_paint',
    {
      title: 'Set fill and stroke',
      description:
        'Changes the paint of paths in an svg node: fill, stroke (color, "none" or linear/radial gradient), strokeWidth, linecap, linejoin, dasharray, opacity. Without pathIds it applies to all; "" removes. Regenerates the markup.',
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
        nodeId: z.string().describe('Id of the svg node, e.g. "sv_ab12cd34".'),
        pathIds: z
          .array(z.string())
          .optional()
          .describe('Ids of the paths to change, e.g. ["p1"] (default: all; see get_svg).'),
        fill: paintField
          .optional()
          .describe('Fill: color ("#6c5ce7", "none", "currentColor"), gradient or "" to remove.'),
        stroke: paintField
          .optional()
          .describe('Stroke: color, gradient or "" to remove, e.g. "#111111".'),
        strokeWidth: z
          .number()
          .min(0)
          .optional()
          .describe('Stroke width in viewBox units, e.g. 2.'),
        linecap: z
          .enum(['butt', 'round', 'square'])
          .optional()
          .describe('Stroke line caps, e.g. "round".'),
        linejoin: z
          .enum(['miter', 'round', 'bevel'])
          .optional()
          .describe('Stroke line joins, e.g. "round".'),
        dasharray: z
          .string()
          .optional()
          .describe('Dash pattern, e.g. "4 2"; "none" or "" removes it.'),
        opacity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Path opacity, from 0 to 1, e.g. 0.8.'),
        fillRule: z
          .enum(['nonzero', 'evenodd'])
          .optional()
          .describe('Fill rule, e.g. "evenodd" (punches holes in subpaths).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({
      nodeId,
      pathIds,
      fill,
      stroke,
      strokeWidth,
      linecap,
      linejoin,
      dasharray,
      opacity,
      fillRule,
      docId,
    }) => {
      const id = store.resolveDocId(docId);
      const { node } = requireNode(store.get(id), nodeId);
      if (node.type !== 'svg') {
        throw new ToolError(
          `Node ${nodeId} is <${node.tag}>, not an svg. For text and boxes use update_styles (color, background).`,
        );
      }
      const vector = guard(() => ensureVector(node));
      if (!vector) throw new ToolError(`Node ${nodeId} has no SVG markup.`);
      if (vector.paths.length === 0) {
        throw new ToolError(
          `Svg ${nodeId} has no editable paths (the imported SVG uses features such as filters, masks or text). Alternatives: set_attrs(nodeIds, { fill: "#hex" }) on the root <svg>, or recreate it with a simplified insert_svg.`,
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
        patch.strokeDasharray =
          dasharray.trim() === '' || dasharray.trim() === 'none' ? null : dasharray.trim();
      if (opacity !== undefined) patch.opacity = opacity;
      if (fillRule !== undefined) patch.fillRule = fillRule;
      if (Object.keys(patch).length === 0) {
        throw new ToolError(
          'Provide at least one property: fill, stroke, strokeWidth, linecap, linejoin, dasharray, opacity or fillRule. E.g. fill "#6c5ce7".',
        );
      }
      const next = guard(() => setVectorPaint(vector, patch, pathIds));
      const r = apply(id, buildSetVectorOps(nodeId, next), 'set_vector_paint');
      const changed = pathIds?.length ?? next.paths.length;
      return `Paint updated on ${changed} path(s) of ${nodeId}; the markup was regenerated.\n${pathsSummary(next).join('\n')}\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  /**
   * Measured boxes (px, in the parent's padding box) of in-flow nodes, via the render engine: measures
   * the parent and subtracts its position and border. Without render, or on failure, it returns only
   * what it got; core then refuses the in-flow node with a clear message.
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
        if (ids.includes(c.id))
          boxes[c.id] = { x: c.x - ox, y: c.y - oy, width: c.width, height: c.height };
      }
    }
    return boxes;
  }

  tool(
    'boolean_op',
    {
      title: 'Boolean operation between vectors',
      description:
        'Combines 2+ sibling svg nodes: union, subtract (the bottom one minus the ones above), intersect or exclude. Curves are flattened. The result replaces the first node and the originals disappear. In-flow nodes need render to measure the position; without it, use position:absolute. Undo with undo.',
      example: { nodeIds: ['sv_aaaa1111', 'sv_bbbb2222'], op: 'subtract', name: 'Hole' },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(2)
          .describe(
            'Ids of 2 or more sibling svg nodes (same parent), e.g. ["sv_aaaa1111", "sv_bbbb2222"].',
          ),
        op: z
          .enum(BOOLEAN_OPS as unknown as [string, ...string[]])
          .describe('Operation: "union", "subtract", "intersect" or "exclude".'),
        name: z.string().optional().describe('Layer name of the result, e.g. "Hole".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeIds, op, name, docId }) => {
      const id = store.resolveDocId(docId);
      // virtual ids (inside instances): read from the expanded view; the ops route them
      const doc = docWithNodes(store.get(id), nodeIds);
      for (const n of nodeIds) requireNode(doc, n);
      const boxes = await flowBoxes(doc, id, nodeIds);
      const built = guard(() =>
        buildBooleanOps(doc, nodeIds, op as (typeof BOOLEAN_OPS)[number], { name, boxes }),
      );
      const r = apply(id, built.ops, 'boolean_op');
      return `Boolean "${op}" applied to ${nodeIds.length} nodes: result ${built.nodeId} (originals removed; curves flattened). Result paint: that of the first path of the bottom-most node; adjust with set_vector_paint.\n${summaryOf(r.doc, [built.nodeId])}`;
    },
  );

  tool(
    'flatten',
    {
      title: 'Flatten vectors',
      description:
        'Flattens vectors. One node: merges the paths into one. Several sibling svgs: a single node with the paths of all of them (each with its own paint). In-flow nodes need render to measure the position; without it, use position:absolute. Undo with undo.',
      example: { nodeIds: ['sv_aaaa1111', 'sv_bbbb2222'] },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .describe('Ids of 1 or more svg nodes (siblings, if several), e.g. ["sv_aaaa1111"].'),
        name: z.string().optional().describe('Layer name of the result, e.g. "Icon".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeIds, name, docId }) => {
      const id = store.resolveDocId(docId);
      // virtual ids (inside instances): read from the expanded view; the ops route them
      const doc = docWithNodes(store.get(id), nodeIds);
      for (const n of nodeIds) requireNode(doc, n);
      const boxes = await flowBoxes(doc, id, nodeIds);
      const built = guard(() => buildFlattenOps(doc, nodeIds, { name, boxes }));
      const r = apply(id, built.ops, 'flatten');
      return `${nodeIds.length} node(s) flattened into ${built.nodeId}.\n${summaryOf(r.doc, [built.nodeId])}`;
    },
  );

  tool(
    'text_to_outlines',
    {
      title: 'Text to outlines',
      description:
        'Converts text nodes into svg with the glyph outlines (document or system font); it stops being editable text. Returns notes (font, line breaks, missing glyphs). Undo with undo.',
      example: { nodeIds: ['tx_ab12cd34'] },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .optional()
          .describe('Ids of the text nodes, e.g. ["tx_ab12cd34"].'),
        nodeId: z.string().optional().describe('Shortcut for a single node, e.g. "tx_ab12cd34".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeIds, nodeId, docId }) => {
      const ids = [...(nodeIds ?? []), ...(nodeId ? [nodeId] : [])];
      if (ids.length === 0) {
        throw new ToolError('Provide nodeIds (or nodeId). E.g. nodeIds ["tx_ab12cd34"].');
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
      const notes = res.notes.length
        ? `\nNotes:\n${res.notes.map((n) => `- ${n}`).join('\n')}`
        : '';
      return `${res.nodeIds.length} text node(s) converted to outlines: ${res.nodeIds.join(', ')}.${notes}\n${summaryOf(r.doc, res.nodeIds)}`;
    },
  );
}
