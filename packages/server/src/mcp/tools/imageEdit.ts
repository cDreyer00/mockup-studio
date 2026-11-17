import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CLIP_PATH_PRESETS,
  IMAGE_FILTERS,
  OBJECT_FIT_VALUES,
  OBJECT_POSITION_PRESETS,
  PLACEHOLDER_KINDS,
  cropToCss,
  mergeImageFilters,
  normalizeObjectPosition,
  resolveClipPath,
  type ImageFilterName,
  type Op,
} from '@mockup/core';
import { detectImage, safeJoin, writeAsset } from '../../assets.js';
import { sanitizeAssetName } from '../../http.js';
import { PlaceholderError, buildPlaceholder } from '../../placeholder.js';
import { ToolError, WRITE, docIdField, type ToolContext } from '../context.js';
import { loadSource } from './images.js';
import { docWithNodes } from '../../component-view.js';

const MAX_DATA_URL_BYTES = 2 * 1024 * 1024;

const filterNum = z.number().nullable().optional();
const filtersSchema = z.strictObject({
  blur: filterNum.describe('Blur in px (0 to 50).'),
  brightness: filterNum.describe('Brightness in % (0 to 300; neutral 100).'),
  contrast: filterNum.describe('Contrast in % (0 to 300; neutral 100).'),
  saturate: filterNum.describe('Saturation in % (0 to 300; neutral 100).'),
  hueRotate: filterNum.describe('Hue in degrees (-180 to 180).'),
  'hue-rotate': filterNum.describe('Same as hueRotate.'),
  sepia: filterNum.describe('Sepia in % (0 to 100).'),
  grayscale: filterNum.describe('Grayscale in % (0 to 100).'),
  invert: filterNum.describe('Invert in % (0 to 100).'),
  opacity: filterNum.describe('Opacity in % (0 to 100; neutral 100).'),
});

const side = z.number().min(0).max(99).optional();

export function registerImageEditTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  tool(
    'set_image',
    {
      title: 'Adjust an image',
      description:
        'Adjusts an image node in one call (one undo): swaps the image, framing (fit, position), filters, crop and shape mask (clipPath). See get_guide("assets").',
      example: {
        nodeId: 'im_ab12cd34',
        fit: 'cover',
        position: 'top',
        filters: { grayscale: 100, blur: 2 },
        crop: { top: 10, bottom: 10 },
        clipPath: 'circle',
      },
      inputSchema: {
        nodeId: z.string().describe('Image node id, e.g. "im_ab12cd34".'),
        source: z
          .string()
          .optional()
          .describe(
            'New image: absolute path, http(s) URL, data URL or an existing relative path in assets/, e.g. "C:/photos/cover.png".',
          ),
        fit: z
          .enum(OBJECT_FIT_VALUES)
          .optional()
          .describe(`object-fit: ${OBJECT_FIT_VALUES.join(', ')}. Ex.: "cover".`),
        position: z
          .string()
          .optional()
          .describe(
            `object-position: preset (${Object.keys(OBJECT_POSITION_PRESETS).join(', ')}) or CSS ("30% 70%").`,
          ),
        filters: filtersSchema
          .optional()
          .describe(
            `Filters as numbers (${IMAGE_FILTERS.map((f) => f.name + ' ' + f.unit).join(', ')}), e.g. { "blur": 2, "grayscale": 100 }; null resets a filter; other CSS filters (drop-shadow) are preserved.`,
          ),
        crop: z
          .strictObject({ top: side, right: side, bottom: side, left: side })
          .nullable()
          .optional()
          .describe(
            'Crop in % of each side of the original image (object-view-box), e.g. { "top": 10, "bottom": 10 }; null or zeros removes it.',
          ),
        clipPath: z
          .string()
          .optional()
          .describe(
            `Mask: shape (${Object.keys(CLIP_PATH_PRESETS).join(', ')}), CSS clip-path or "none" to remove.`,
          ),
        alt: z.string().optional().describe('Alternative text (alt attribute).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeId, source, fit, position, filters, crop, clipPath, alt, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const node = requireNode(doc, nodeId).node;
      if (node.type !== 'image') {
        throw new ToolError(
          `Node ${nodeId} is ${node.type}, not an image. Use insert_image to create one, or pass the id of an image node (get_tree_summary).`,
        );
      }
      const ops: Op[] = [];
      let note = '';
      if (source !== undefined) {
        const s = source.trim();
        const isRelative = !/^(data:|https?:\/\/)/i.test(s) && !path.isAbsolute(s);
        let src: string;
        if (isRelative) {
          const assets = store.assetsDir(id);
          const rel = s.replace(/\\/g, '/').replace(/^assets\//, '');
          const full = assets ? safeJoin(assets, rel) : null;
          if (!full || !fs.existsSync(full)) {
            throw new ToolError(
              `Could not find "${s}" in assets/. Use an absolute path, URL or data URL, or list_assets to see the document's files.`,
            );
          }
          src = rel;
          note = `image: assets/${rel}`;
        } else {
          const { bytes, hint } = await loadSource(s);
          const info = detectImage(bytes);
          if (!info) {
            throw new ToolError(
              'The content is not a recognized image (PNG, JPEG, GIF, WebP, SVG or AVIF). Check the file or the URL.',
            );
          }
          const assets = store.assetsDir(id);
          if (assets) {
            const stem = hint.replace(/\.[^.]*$/, '') || 'image';
            const safe = sanitizeAssetName(`${stem}${info.ext}`);
            src = await writeAsset(assets, `${safe.base}${safe.ext}`, bytes);
            note = `image: assets/${src}`;
          } else {
            if (bytes.length > MAX_DATA_URL_BYTES) {
              throw new ToolError(
                'The document has no path on disk yet and the image exceeds 2 MB for embedding. Save the document and try again.',
              );
            }
            src = `data:${info.mime};base64,${bytes.toString('base64')}`;
            note = 'image: embedded data URL';
          }
        }
        ops.push({ type: 'setSrc', changes: [{ nodeId, src }] });
      }
      if (alt !== undefined) ops.push({ type: 'setAttrs', changes: [{ nodeId, set: { alt } }] });

      const set: Record<string, string> = {};
      const unset: string[] = [];
      const put = (prop: string, value: string): void => {
        if (value) set[prop] = value;
        else unset.push(prop);
      };
      if (fit) set['object-fit'] = fit;
      if (position !== undefined) {
        if (!position.trim())
          throw new ToolError('position is empty. E.g. "top-left" or "30% 70%".');
        set['object-position'] = normalizeObjectPosition(position);
      }
      if (filters) {
        const changes: Partial<Record<ImageFilterName, number | null>> = {};
        for (const [k, v] of Object.entries(filters)) {
          if (v === undefined) continue;
          changes[(k === 'hueRotate' ? 'hue-rotate' : k) as ImageFilterName] = v;
        }
        put('filter', mergeImageFilters(node.style['filter'], changes));
      }
      if (crop !== undefined) {
        put(
          'object-view-box',
          crop === null
            ? ''
            : cropToCss({
                top: crop.top ?? 0,
                right: crop.right ?? 0,
                bottom: crop.bottom ?? 0,
                left: crop.left ?? 0,
              }),
        );
      }
      if (clipPath !== undefined) {
        if (!clipPath.trim()) throw new ToolError('clipPath is empty. Use "circle" or "none".');
        if (/url\(\s*(?!['"]?#)/i.test(clipPath)) {
          throw new ToolError(
            'clipPath with url() only accepts an internal reference (url(#id)); use a shape or polygon()/inset()/circle().',
          );
        }
        put('clip-path', resolveClipPath(clipPath));
      }
      if (Object.keys(set).length || unset.length) {
        ops.push({
          type: 'updateStyles',
          changes: [
            {
              nodeId,
              ...(Object.keys(set).length ? { set } : {}),
              ...(unset.length ? { unset } : {}),
            },
          ],
        });
      }
      if (ops.length === 0) {
        throw new ToolError(
          'Nothing to adjust. Provide at least one of: source, fit, position, filters, crop, clipPath, alt.',
        );
      }
      const r = apply(id, ops, 'set_image');
      const after = requireNode(r.doc, nodeId).node;
      const keys = ['object-fit', 'object-position', 'filter', 'object-view-box', 'clip-path'];
      const styles = keys
        .filter((k) => after.style[k])
        .map((k) => `${k}: ${after.style[k]}`)
        .join('; ');
      return `Image ${nodeId} adjusted${note ? ` (${note})` : ''}. Image styles: ${styles || '(none)'}.\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'generate_placeholder',
    {
      title: 'Generate sample image (placeholder)',
      description:
        'Generates an offline, deterministic SVG placeholder (same seed, same file). On an image node it swaps the src; on a container it creates a child image. Writes to assets/placeholders/ (or a data URL when there is no path).',
      example: { nodeId: 'el_ab12cd34', kind: 'avatar', seed: 'ana', width: 96, height: 96 },
      inputSchema: {
        nodeId: z.string().describe('Id of an image node or a container, e.g. "el_ab12cd34".'),
        kind: z
          .enum(PLACEHOLDER_KINDS)
          .describe(`Kind: ${PLACEHOLDER_KINDS.join(', ')}. E.g. "avatar".`),
        seed: z
          .string()
          .optional()
          .describe('Seed: the same text always generates the same image, e.g. "ana".'),
        width: z.number().positive().optional().describe('SVG width in px, e.g. 600.'),
        height: z.number().positive().optional().describe('SVG height in px, e.g. 400.'),
        label: z
          .string()
          .optional()
          .describe('Logo text (or name for the avatar initials), e.g. "Acme".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeId, kind, seed, width, height, label, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = docWithNodes(store.get(id), [nodeId]);
      requireNode(doc, nodeId);
      let r;
      try {
        r = await buildPlaceholder(doc, store.assetsDir(id), {
          nodeId,
          kind,
          ...(seed !== undefined ? { seed } : {}),
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
          ...(label ? { label } : {}),
        });
      } catch (e) {
        if (e instanceof PlaceholderError) throw new ToolError(e.message);
        throw e;
      }
      const out = apply(id, r.ops, 'generate_placeholder');
      const created = r.nodeId !== nodeId ? ` (image created: ${r.nodeId})` : '';
      return `Placeholder ${kind} applied${created}; file: ${r.where}.\n${summaryOf(out.doc, [r.nodeId], [nodeId])}`;
    },
  );
}
