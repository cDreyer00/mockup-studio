import { z } from 'zod';
import {
  PREVIEW_STATES,
  formatGridTracks,
  frameMotionTimeline,
  getFrameOf,
  type LayoutNode,
} from '@mockup/core';
import { renderTargetFor, type RenderTarget } from '../../component-view.js';
import { renderUnavailableMessage } from '../../render.js';
import { READ, ToolError, docIdField, type ToolContext } from '../context.js';

const short = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;

/** One line per node: `id "name" tag x,y wxh` (+ line text); children beyond `depth` become a count. */
export function formatLayout(root: LayoutNode, depth: number): string {
  const lines: string[] = [];
  const walk = (n: LayoutNode, level: number): void => {
    const pad = '  '.repeat(level);
    const text = n.lines?.length
      ? ` "${short(
          n.lines
            .map((l) => l.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
          60,
        )}"`
      : '';
    lines.push(
      `${pad}${n.id} "${n.name}" ${n.tag} ${Math.round(n.x)},${Math.round(n.y)} ${Math.round(n.width)}x${Math.round(n.height)}${text}`,
    );
    if (n.grid) lines.push(`${pad}  ${formatGridTracks(n.grid)}`);
    if (level >= depth) {
      if (n.children.length)
        lines.push(`${pad}  … ${n.children.length} child(ren) beyond the depth`);
      return;
    }
    for (const c of n.children) walk(c, level + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}

export function registerRenderTools(ctx: ToolContext): void {
  const { tool, store, opts, readNode } = ctx;

  /**
   * Render target: document with expanded instances (the render page does not know
   * components); `cp_...` and main component nodes render in a default instance.
   */
  const targetOf = (doc: Parameters<typeof renderTargetFor>[0], id: string): RenderTarget => {
    const t = renderTargetFor(doc, id);
    if (!t) {
      readNode(doc, id); // throws the standard node-not-found error
      throw new ToolError(`Node not found: "${id}".`);
    }
    return t;
  };

  const needRender = () => {
    if (!opts.render)
      throw new ToolError(renderUnavailableMessage({ pid: process.pid, port: opts.getPort?.() }));
    return opts.render;
  };

  tool(
    'get_screenshot',
    {
      title: 'Node screenshot',
      description:
        'Renders a node and returns the IMAGE; use it after each set of changes to check them. Tip: scale 1 and maxWidth 800 use less context. Without nodeId it uses the selection or the first frame. state shows hover, dark, etc. Requires render.',
      example: { nodeId: 'fr_ab12cd34', scale: 1, format: 'png', maxWidth: 800 },
      inputSchema: {
        nodeId: z
          .string()
          .optional()
          .describe('Node id, e.g. "fr_ab12cd34" (default: current selection or first frame).'),
        scale: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe('Pixel scale: 1 (default), 2 or 3. E.g. 2 to check details.'),
        format: z
          .enum(['png', 'jpg'])
          .optional()
          .describe('"png" (default) or "jpg" (smaller file), e.g. "png".'),
        maxWidth: z
          .number()
          .int()
          .min(16)
          .optional()
          .describe('Maximum image width in px; scales down keeping the aspect ratio. E.g. 800.'),
        transparent: z
          .boolean()
          .optional()
          .describe(
            'true makes the background transparent outside the content (png only). Default false.',
          ),
        state: z
          .enum(PREVIEW_STATES)
          .optional()
          .describe(
            `Preview state (see get_guide("tailwind")): ${PREVIEW_STATES.join(', ')}. Shows the node with the states (hover:, dark:...) applied, e.g. "hover".`,
          ),
        time: z
          .number()
          .min(0)
          .optional()
          .describe(
            'Seconds on the frame linear motion timeline (node animations, builds back to back; see get_timeline) and on the effects clock (effects, particles, Lottie, Rive, Three.js, video). E.g. 1.5. With no time/build/times you see the design state (animations at rest). With build: seconds into that build.',
          ),
        build: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe(
            'State after this many CLICKS of the presentation (like presentation_goto build): 0 = only the automatic build, 1 = after the first click... Counts clicks in play order, not build numbers (builds 0, 2, 5: build 1 here = after build 2). Later builds have not started. With time: seconds into the build. E.g. 1.',
          ),
        times: z
          .array(z.number().min(0).max(600))
          .min(1)
          .max(12)
          .optional()
          .describe(
            'Filmstrip: one cell per instant (s) in a SINGLE image, a cheap way to see a whole animation, e.g. [0, 0.3, 0.6, 1, 1.5]. Relative to build when given. Max 12; replaces time.',
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe('Filmstrip columns, 1 to 12 (default: up to 4).'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({
      nodeId,
      scale,
      format,
      maxWidth,
      transparent,
      state,
      time,
      build,
      times,
      columns,
      docId,
    }) => {
      const render = needRender();
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const target = nodeId ?? ctx.selectedOrFirstFrame(id, doc);
      const rt = targetOf(doc, target);
      const fmt = format ?? 'png';
      let r;
      try {
        r = await render.capture({
          doc: rt.doc,
          docId: id,
          nodeId: rt.nodeId,
          assetsDir: store.assetsDir(id),
          scale: scale ?? 1,
          format: fmt,
          maxWidth,
          transparent,
          ...(state ? { state } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(build !== undefined ? { build } : {}),
          ...(times !== undefined ? { times } : {}),
          ...(columns !== undefined ? { columns } : {}),
        });
      } catch (e) {
        throw new ToolError(
          `Failed to render ${target}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const ext = r.mime === 'image/jpeg' ? 'jpg' : 'png';
      let text = `${target} "${rt.name}": ${Math.round(r.width)}x${Math.round(r.height)} px (image ${r.pixelWidth}x${r.pixelHeight} ${ext}, ${kb(r.data.length)})${state ? ` with state "${state}"` : ''}`;
      if (time === undefined && build === undefined && times === undefined) {
        const frame = getFrameOf(rt.doc, rt.nodeId);
        const tl = frame ? frameMotionTimeline(frame) : undefined;
        if (tl && tl.items.length > 0) {
          const n = tl.items.length;
          const clicks = tl.clicks ? `, ${tl.clicks} click build${tl.clicks === 1 ? '' : 's'}` : '';
          text += `
This frame has ${n} animation${n === 1 ? '' : 's'} (${(tl.duration / 1000).toFixed(1)} s${clicks}): pass time, build or times to see them.`;
        }
      }
      return { images: [{ data: r.data.toString('base64'), mimeType: r.mime }], text };
    },
  );

  tool(
    'get_layout',
    {
      title: 'Actual layout measurements',
      description:
        'Actual (rendered) position and size of a node and its descendants, one line per node: id "name" tag x,y wxh, plus the line text and, for grids, the tracks (grid cols x+w,... rows ... gap). Requires render.',
      example: { nodeId: 'fr_ab12cd34', depth: 3 },
      inputSchema: {
        nodeId: z.string().describe('Id of the measurement root node, e.g. "fr_ab12cd34".'),
        depth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe(
            'Levels of descendants shown, 0 to 10, e.g. 3 (default 3); the rest becomes a count.',
          ),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeId, depth, docId }) => {
      const render = needRender();
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const rt = targetOf(doc, nodeId);
      let layout: LayoutNode;
      try {
        layout = await render.measure({
          doc: rt.doc,
          docId: id,
          nodeId: rt.nodeId,
          assetsDir: store.assetsDir(id),
        });
      } catch (e) {
        throw new ToolError(
          `Failed to measure ${nodeId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return formatLayout(layout, depth ?? 3);
    },
  );
}
