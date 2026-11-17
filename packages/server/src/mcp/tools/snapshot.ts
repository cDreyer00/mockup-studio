import { z } from 'zod';
import { findNode } from '@mockup/core';
import { IMPORT_VIEWPORT_LIMITS, planCleanup } from '@mockup/snapshot-core';
import type { SnapshotImportResult } from '@mockup/snapshot-core';
import {
  importFromHtml,
  importFromUrl,
  IMPORT_URL_NEEDS_RENDER,
  type SnapshotServiceCtx,
} from '../../snapshot/service.js';
import { SnapshotImportError } from '../../snapshot/validate.js';
import { ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

const placementFields = {
  name: z
    .string()
    .optional()
    .describe('Name of the created frame, e.g. "Site X hero" (default: page or element title).'),
  reference: z
    .boolean()
    .optional()
    .describe('Attach the screenshot as a hidden "Reference" frame alongside (default true).'),
  pageId: z.string().optional().describe('Page id, e.g. "pg_ab12cd34" (default: the first).'),
  x: z
    .number()
    .optional()
    .describe(
      'X position of the frame on the canvas, e.g. 1600 (default: right of the last frame).',
    ),
  y: z
    .number()
    .optional()
    .describe('Y position of the frame on the canvas, e.g. 0 (default: y of the first frame).'),
  docId: docIdField,
};

const captureFields = {
  selector: z
    .string()
    .optional()
    .describe(
      'CSS selector of the element to import, e.g. "header" or "#hero" (default: body, the whole page).',
    ),
  width: z
    .number()
    .min(IMPORT_VIEWPORT_LIMITS.minWidth)
    .max(IMPORT_VIEWPORT_LIMITS.maxWidth)
    .optional()
    .describe(
      `Viewport width in px, from ${IMPORT_VIEWPORT_LIMITS.minWidth} to ${IMPORT_VIEWPORT_LIMITS.maxWidth}, e.g. 1440 (default 1440); picks the site's breakpoint.`,
    ),
  height: z
    .number()
    .min(IMPORT_VIEWPORT_LIMITS.minHeight)
    .max(IMPORT_VIEWPORT_LIMITS.maxHeight)
    .optional()
    .describe(
      `Viewport height in px, from ${IMPORT_VIEWPORT_LIMITS.minHeight} to ${IMPORT_VIEWPORT_LIMITS.maxHeight}, e.g. 900 (default 900).`,
    ),
  timeout_ms: z
    .number()
    .positive()
    .optional()
    .describe('Maximum capture time in ms, up to 60000, e.g. 30000 (default 20000).'),
};

const viewportOf = (width?: number, height?: number) =>
  width !== undefined || height !== undefined ? { width, height } : undefined;

export function registerSnapshotTools(ctx: ToolContext): void {
  const { tool, store, summaryOf } = ctx;
  const service: SnapshotServiceCtx = { store, render: ctx.opts.render, source: 'mcp' };

  const describe = (r: SnapshotImportResult, origin: string): string => {
    const doc = store.get(r.docId);
    const frame = findNode(doc, r.frameId)?.node;
    const fonts = r.fonts.length ? `fonts: ${r.fonts.join(', ')}` : 'no new fonts';
    const head =
      `Imported from ${origin}: ${r.frameId} "${frame?.name ?? ''}" ` +
      `(${r.nodes} nodes, ${r.images} images, ${fonts}).` +
      (r.referenceId ? ` Hidden reference: ${r.referenceId}.` : '');
    const lines = [head];
    if (r.warnings.length) lines.push('Warnings:', ...r.warnings.map((w) => `- ${w}`));
    lines.push(summaryOf(doc, [r.frameId]));
    lines.push(
      `Next steps: check with get_screenshot(${r.frameId}) and simplify with cleanup_imported(${r.frameId}).` +
        (r.referenceId
          ? ` To compare with the original: set_node_flags on ${r.referenceId} with hidden:false (or get_screenshot of it).`
          : ''),
    );
    return lines.join('\n');
  };

  tool(
    'import_url',
    {
      title: 'Import from a URL',
      description:
        'Imports a page or section of a website (http/https URL) as an editable frame, with computed styles, images and fonts. Needs the render engine. Afterwards: get_screenshot and cleanup_imported.',
      example: { url: 'https://example.com', selector: 'header', width: 1440 },
      inputSchema: {
        url: z
          .string()
          .describe('http(s) address of the page, e.g. "https://example.com/pricing".'),
        ...captureFields,
        ...placementFields,
      },
      annotations: WRITE,
    },
    async ({ url, selector, width, height, timeout_ms, reference, name, pageId, x, y, docId }) => {
      try {
        const r = await importFromUrl(service, {
          url,
          selector,
          viewport: viewportOf(width, height),
          timeoutMs: timeout_ms,
          reference,
          name,
          pageId,
          x,
          y,
          docId,
        });
        return describe(r, url);
      } catch (e) {
        if (e instanceof SnapshotImportError && e.message === IMPORT_URL_NEEDS_RENDER)
          throw new ToolError(
            `${IMPORT_URL_NEEDS_RENDER} Alternatives: import_html (paste the page HTML; without render the conversion is simpler) or the browser extension.`,
          );
        throw e;
      }
    },
  );

  tool(
    'import_html',
    {
      title: 'Import HTML',
      description:
        'Imports HTML (and optional CSS) as an editable frame. With render it captures computed styles; without render it uses a simple conversion (less faithful). assets_base_url resolves relative URLs.',
      example: {
        html: '<section><h1>Hello</h1><p>Text</p></section>',
        css: 'h1{color:#6c5ce7}',
        width: 1280,
      },
      inputSchema: {
        // no `.min(1)`: empty and whitespace-only input fall into the same clear service message
        html: z
          .string()
          .describe('Full HTML or fragment, e.g. "<section><h1>Hello</h1></section>".'),
        css: z
          .string()
          .optional()
          .describe('Extra CSS applied to the HTML, e.g. "h1{color:#6c5ce7}".'),
        assets_base_url: z
          .string()
          .optional()
          .describe('Base http(s) URL for relative links and images, e.g. "https://example.com/".'),
        ...captureFields,
        ...placementFields,
      },
      annotations: WRITE,
    },
    async ({
      html,
      css,
      assets_base_url,
      selector,
      width,
      height,
      timeout_ms,
      reference,
      name,
      pageId,
      x,
      y,
      docId,
    }) => {
      const r = await importFromHtml(service, {
        html,
        css,
        assetsBaseUrl: assets_base_url,
        selector,
        viewport: viewportOf(width, height),
        timeoutMs: timeout_ms,
        reference,
        name,
        pageId,
        x,
        y,
        docId,
      });
      const how =
        r.method === 'snapshot'
          ? 'capture with computed styles (render engine)'
          : 'conversion without render (lower fidelity)';
      return describe(r, `HTML (${how})`);
    },
  );

  tool(
    'cleanup_imported',
    {
      title: 'Simplify imported frame',
      description:
        'Cleans the tree of an imported frame: removes empty wrappers, unwraps unstyled divs and replaces redundant fixed widths/heights with automatic ones. One history entry (undo reverts it).',
      example: { nodeId: 'fr_ab12cd34', fluid: true },
      inputSchema: {
        nodeId: z
          .string()
          .describe('Id of the imported frame or node to clean, e.g. "fr_ab12cd34".'),
        remove_empty: z
          .boolean()
          .optional()
          .describe('Remove empty divs/spans with no visual style (default true).'),
        unwrap: z
          .boolean()
          .optional()
          .describe('Unwrap unstyled wrappers with a single child (default true).'),
        fluid: z
          .boolean()
          .optional()
          .describe(
            "Fluid sizes: a px width equal to the parent's becomes auto and a px height on nodes with content becomes min-height (default true).",
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, remove_empty, unwrap, fluid, docId }) => {
      const id = store.resolveDocId(docId);
      ctx.requireNode(store.get(id), nodeId);
      const plan = planCleanup(store.get(id), nodeId, {
        removeEmpty: remove_empty,
        unwrap,
        fluid,
      });
      if (plan.ops.length === 0) return `Nothing to clean in ${nodeId}.`;
      const r = ctx.apply(id, plan.ops, 'cleanup_imported');
      return [
        `Cleanup of ${nodeId}: ${plan.removed} empty node(s) removed, ${plan.unwrapped} wrapper(s) unwrapped, ${plan.fluid} fixed size(s) made automatic.`,
        summaryOf(r.doc, [nodeId]),
        `Check with get_screenshot(${nodeId}); revert with undo if something changed too much.`,
      ].join('\n');
    },
  );
}
