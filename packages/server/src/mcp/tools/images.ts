import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createNodeFromTag, getComputedLike } from '@mockup/core';
import { detectImage, fetchBytes, parseDataUrl, writeAsset, type ImageInfo } from '../../assets.js';
import { MAX_ASSET_BYTES, sanitizeAssetName } from '../../http.js';
import {
  buildKitIconSvg,
  isStrokeIcon,
  resolveIcon,
  searchIcons,
  suggestSimilarIcons,
} from '../../icons.js';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

export const MAX_DATA_URL_BYTES = 2 * 1024 * 1024;

export interface Loaded {
  bytes: Buffer;
  /** Suggested base name for the file (without a trustworthy extension). */
  hint: string;
}

export async function loadSource(source: string): Promise<Loaded> {
  const src = source.trim();
  if (src.startsWith('data:')) {
    const d = parseDataUrl(src);
    if (!d) throw new ToolError('Invalid data URL. E.g. "data:image/png;base64,iVBORw0...".');
    if (d.bytes.length > MAX_ASSET_BYTES) throw new ToolError('The image exceeds the 20 MB limit.');
    return { bytes: d.bytes, hint: 'image' };
  }
  if (/^https?:\/\//i.test(src)) {
    let r;
    try {
      r = await fetchBytes(src, { maxBytes: MAX_ASSET_BYTES, timeoutMs: 20_000 });
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : String(e));
    }
    if (
      r.contentType &&
      !r.contentType.startsWith('image/') &&
      r.contentType !== 'application/octet-stream'
    ) {
      throw new ToolError(
        `The URL returned "${r.contentType}", not an image. Use the direct address of the file (png, jpg, gif, webp, svg, avif).`,
      );
    }
    let hint = 'image';
    try {
      hint = path.basename(new URL(r.finalUrl).pathname) || hint;
    } catch {
      // keep the default
    }
    return { bytes: r.bytes, hint };
  }
  if (!path.isAbsolute(src)) {
    throw new ToolError(
      `source must be an absolute path, http(s) URL or data URL; received "${src}".`,
    );
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(src);
  } catch {
    throw new ToolError(`File not found: ${src}`);
  }
  if (!st.isFile()) throw new ToolError(`"${src}" is not a file.`);
  if (st.size > MAX_ASSET_BYTES) throw new ToolError('The image exceeds the 20 MB limit.');
  return { bytes: await fs.promises.readFile(src), hint: path.basename(src) };
}

export function registerImageTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  tool(
    'insert_image',
    {
      title: 'Insert image',
      description:
        'Inserts an image (img node) into parentId from an absolute path, http(s) URL or data URL; validates the bytes and copies it to assets/. Without width it uses the intrinsic size.',
      example: {
        parentId: 'fr_ab12cd34',
        source: 'C:/photos/cover.png',
        alt: 'Cover',
        styles: { width: '320px' },
      },
      inputSchema: {
        parentId: z.string().describe('Parent id, e.g. "fr_ab12cd34".'),
        source: z
          .string()
          .describe(
            'Absolute path, http(s) URL or data URL of the image. E.g. "C:/photos/cover.png".',
          ),
        alt: z
          .string()
          .optional()
          .describe('Alternative text (alt attribute), e.g. "Cover photo".'),
        styles: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'CSS styles, e.g. { "width": "320px", "border-radius": "12px", "object-fit": "cover" }.',
          ),
        name: z.string().optional().describe('Layer name, e.g. "Cover photo".'),
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
    async ({ parentId, source, alt, styles, name, index, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const { bytes, hint } = await loadSource(source);
      const info: ImageInfo | null = detectImage(bytes);
      if (!info) {
        throw new ToolError(
          'The content is not a recognized image (PNG, JPEG, GIF, WebP, SVG or AVIF). Check the file or the URL.',
        );
      }
      const assets = store.assetsDir(id);
      let src: string;
      let where: string;
      if (assets) {
        const stem = hint.replace(/\.[^.]*$/, '') || 'image';
        const safe = sanitizeAssetName(`${stem}${info.ext}`);
        const file = await writeAsset(assets, `${safe.base}${safe.ext}`, bytes);
        src = file;
        where = `assets/${file}`;
      } else {
        if (bytes.length > MAX_DATA_URL_BYTES) {
          throw new ToolError(
            'The document has no path on disk yet and the image exceeds 2 MB for embedding. Save the document (create_document or Save As) and try again.',
          );
        }
        src = `data:${info.mime};base64,${bytes.toString('base64')}`;
        where = 'embedded data URL';
      }
      const st = { ...(styles ?? {}) };
      if (!st['width'] && info.width && info.height) {
        st['width'] = `${info.width}px`;
        if (!st['height']) st['height'] = `${info.height}px`;
      }
      const node = createNodeFromTag('img', {
        name: name ?? 'Image',
        src,
        attrs: alt !== undefined ? { alt } : {},
        styles: st,
      });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_image');
      const dims = info.width ? ` ${info.width}x${info.height} px` : '';
      return `Image inserted: ${node.id} (${info.mime}${dims}, ${Math.max(1, Math.round(bytes.length / 1024))} KB) in ${parentId}; file: ${where}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'insert_icon',
    {
      title: 'Insert icon',
      description:
        'Inserts an icon (svg node) from Lucide or Heroicons. name: "arrow-right", "lucide/..." or "heroicons/..." (without kit: Lucide, then Heroicons). Heroicons without a suffix = outline; "-solid", "-20-solid", "-16-solid" = filled. Without color it uses the parent\'s text color. See search_icons.',
      example: {
        parentId: 'el_ab12cd34',
        name: 'heroicons/arrow-right',
        size: 24,
        color: '#0f172a',
      },
      inputSchema: {
        parentId: z.string().describe('Parent id, e.g. "el_ab12cd34".'),
        name: z
          .string()
          .describe('Icon name, e.g. "arrow-right", "lucide/search", "heroicons/user-solid".'),
        kit: z
          .enum(['lucide', 'heroicons'])
          .optional()
          .describe(
            'Kit, e.g. "heroicons" (default: from the name prefix; without a prefix, Lucide then Heroicons).',
          ),
        size: z.number().positive().optional().describe('Size in px, e.g. 24 (default 24).'),
        color: z
          .string()
          .optional()
          .describe('Icon color, e.g. "#0f172a" (default: the parent\'s text color).'),
        stroke_width: z
          .number()
          .positive()
          .max(6)
          .optional()
          .describe(
            'Stroke width (Lucide and outline Heroicons only), greater than 0 and up to 6, e.g. 1.5 (default: 2 in Lucide, 1.5 in Heroicons).',
          ),
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
    async ({ parentId, name, kit, size, color, stroke_width, index, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireNode(doc, parentId);
      const ref = await resolveIcon(name, kit);
      if (!ref) {
        const sug = await suggestSimilarIcons(name, { kit, limit: 6 });
        throw new ToolError(
          `Icon "${name}" does not exist${kit ? ` in the ${kit} kit` : ' (Lucide, Heroicons)'}.${sug.length ? ` Similar: ${sug.join(', ')}.` : ''} Use search_icons(query) to search.`,
        );
      }
      let stroke = color?.trim();
      if (stroke) {
        if (!/^[#a-zA-Z0-9(),.%\s/-]+$/.test(stroke))
          throw new ToolError(`Invalid color: "${color}". E.g. "#6c5ce7" or "rgb(0 0 0)".`);
      } else {
        const inherited = getComputedLike(doc, parentId)['color']?.trim();
        stroke =
          inherited && !/currentcolor|inherit|initial|unset|var\(/i.test(inherited)
            ? inherited
            : '#111111';
      }
      const px = size ?? 24;
      const svg = await buildKitIconSvg(ref, {
        size: px,
        color: stroke,
        strokeWidth: isStrokeIcon(ref) ? stroke_width : undefined,
      });
      const label = `${ref.kit}/${ref.name}`;
      const node = createNodeFromTag('svg', {
        name: `Icon ${label}`,
        svg,
        styles: { width: `${px}px`, height: `${px}px` },
      });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_icon');
      const ignored =
        stroke_width !== undefined && !isStrokeIcon(ref)
          ? ' stroke_width ignored: filled (solid) icon.'
          : '';
      return `Icon "${label}" inserted: ${node.id} (${px}px, color ${stroke}) in ${parentId}.${ignored}\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'search_icons',
    {
      title: 'Search icons (Lucide, Heroicons)',
      description:
        'Searches icons offline by name or tag (in English) in Lucide, Heroicons or both (kit "all", the default). Returns "- kit/name (tags)" lines to use with insert_icon. In Heroicons the tags are the style: outline, solid, 20-solid, 16-solid.',
      example: { query: 'cart', kit: 'all', limit: 10 },
      inputSchema: {
        query: z.string().min(1).describe('Search term, e.g. "cart".'),
        kit: z
          .enum(['lucide', 'heroicons', 'all'])
          .optional()
          .describe('Kit to search, e.g. "heroicons" (default "all").'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum results, from 1 to 100, e.g. 10 (default 20).'),
      },
      annotations: READ,
    },
    async ({ query, kit, limit }) => {
      const hits = await searchIcons(query, { kit, limit: limit ?? 20 });
      if (!hits.length) {
        const sug = await suggestSimilarIcons(query, {
          kit: kit && kit !== 'all' ? kit : undefined,
          limit: 5,
        });
        return `No icons for "${query}".${sug.length ? ` Similar: ${sug.join(', ')}.` : ''}`;
      }
      return (
        `${hits.length} icon(s) for "${query}":\n` +
        hits
          .map(
            (h) =>
              `- ${h.kit}/${h.name}${h.tags.length ? ` (${h.tags.slice(0, 4).join(', ')})` : ''}`,
          )
          .join('\n')
      );
    },
  );
}
