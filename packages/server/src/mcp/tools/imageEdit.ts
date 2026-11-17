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

const MAX_DATA_URL_BYTES = 2 * 1024 * 1024;

const filterNum = z.number().nullable().optional();
const filtersSchema = z.strictObject({
  blur: filterNum.describe('Desfoque em px (0 a 50).'),
  brightness: filterNum.describe('Brilho em % (0 a 300; neutro 100).'),
  contrast: filterNum.describe('Contraste em % (0 a 300; neutro 100).'),
  saturate: filterNum.describe('Saturação em % (0 a 300; neutro 100).'),
  hueRotate: filterNum.describe('Matiz em graus (-180 a 180).'),
  'hue-rotate': filterNum.describe('Igual a hueRotate.'),
  sepia: filterNum.describe('Sépia em % (0 a 100).'),
  grayscale: filterNum.describe('Escala de cinza em % (0 a 100).'),
  invert: filterNum.describe('Inverter em % (0 a 100).'),
  opacity: filterNum.describe('Opacidade em % (0 a 100; neutro 100).'),
});

const side = z.number().min(0).max(99).optional();

export function registerImageEditTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  tool(
    'set_image',
    {
      title: 'Ajustar uma imagem',
      description:
        'Ajusta um nó image em uma chamada (um undo): troca a imagem, enquadramento (fit, position), filtros, recorte (crop) e máscara de forma (clipPath). Veja get_guide("assets").',
      example: {
        nodeId: 'im_ab12cd34',
        fit: 'cover',
        position: 'top',
        filters: { grayscale: 100, blur: 2 },
        crop: { top: 10, bottom: 10 },
        clipPath: 'circle',
      },
      inputSchema: {
        nodeId: z.string().describe('Id do nó image, ex.: "im_ab12cd34".'),
        source: z
          .string()
          .optional()
          .describe(
            'Nova imagem: caminho absoluto, URL http(s), data URL ou caminho relativo já existente em assets/, ex.: "C:/fotos/capa.png".',
          ),
        fit: z
          .enum(OBJECT_FIT_VALUES)
          .optional()
          .describe(`object-fit: ${OBJECT_FIT_VALUES.join(', ')}. Ex.: "cover".`),
        position: z
          .string()
          .optional()
          .describe(
            `object-position: atalho (${Object.keys(OBJECT_POSITION_PRESETS).join(', ')}) ou CSS ("30% 70%").`,
          ),
        filters: filtersSchema
          .optional()
          .describe(
            `Filtros em números (${IMAGE_FILTERS.map((f) => f.name + ' ' + f.unit).join(', ')}), ex.: { "blur": 2, "grayscale": 100 }; null zera um filtro; outros filtros do CSS (drop-shadow) são preservados.`,
          ),
        crop: z
          .strictObject({ top: side, right: side, bottom: side, left: side })
          .nullable()
          .optional()
          .describe(
            'Recorte em % de cada lado da imagem original (object-view-box), ex.: { "top": 10, "bottom": 10 }; null ou zeros remove.',
          ),
        clipPath: z
          .string()
          .optional()
          .describe(
            `Máscara: forma (${Object.keys(CLIP_PATH_PRESETS).join(', ')}), CSS clip-path ou "none" para remover.`,
          ),
        alt: z.string().optional().describe('Texto alternativo (atributo alt).'),
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
          `O nó ${nodeId} é ${node.type}, não uma imagem. Use insert_image para criar uma, ou passe o id de um nó image (get_tree_summary).`,
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
              `Não achei "${s}" em assets/. Use um caminho absoluto, URL ou data URL, ou list_assets para ver os arquivos do documento.`,
            );
          }
          src = rel;
          note = `imagem: assets/${rel}`;
        } else {
          const { bytes, hint } = await loadSource(s);
          const info = detectImage(bytes);
          if (!info) {
            throw new ToolError(
              'O conteúdo não é uma imagem reconhecida (PNG, JPEG, GIF, WebP, SVG ou AVIF). Confira o arquivo ou a URL.',
            );
          }
          const assets = store.assetsDir(id);
          if (assets) {
            const stem = hint.replace(/\.[^.]*$/, '') || 'imagem';
            const safe = sanitizeAssetName(`${stem}${info.ext}`);
            src = await writeAsset(assets, `${safe.base}${safe.ext}`, bytes);
            note = `imagem: assets/${src}`;
          } else {
            if (bytes.length > MAX_DATA_URL_BYTES) {
              throw new ToolError(
                'O documento ainda não tem caminho em disco e a imagem passa de 2 MB para embutir. Salve o documento e tente de novo.',
              );
            }
            src = `data:${info.mime};base64,${bytes.toString('base64')}`;
            note = 'imagem: data URL embutida';
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
        if (!position.trim()) throw new ToolError('position vazio. Ex.: "top-left" ou "30% 70%".');
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
        if (!clipPath.trim()) throw new ToolError('clipPath vazio. Use "circle" ou "none".');
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
          'Nada para ajustar. Informe ao menos um de: source, fit, position, filters, crop, clipPath, alt.',
        );
      }
      const r = apply(id, ops, 'set_image');
      const after = requireNode(r.doc, nodeId).node;
      const keys = ['object-fit', 'object-position', 'filter', 'object-view-box', 'clip-path'];
      const styles = keys
        .filter((k) => after.style[k])
        .map((k) => `${k}: ${after.style[k]}`)
        .join('; ');
      return `Imagem ${nodeId} ajustada${note ? ` (${note})` : ''}. Estilos de imagem: ${styles || '(nenhum)'}.\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'generate_placeholder',
    {
      title: 'Gerar imagem de exemplo (placeholder)',
      description:
        'Gera um placeholder SVG offline e determinístico (mesma seed, mesmo arquivo). Em nó image troca o src; em contêiner cria uma imagem filha. Grava em assets/placeholders/ (ou data URL sem caminho).',
      example: { nodeId: 'el_ab12cd34', kind: 'avatar', seed: 'ana', width: 96, height: 96 },
      inputSchema: {
        nodeId: z.string().describe('Id de um nó image ou de um contêiner, ex.: "el_ab12cd34".'),
        kind: z
          .enum(PLACEHOLDER_KINDS)
          .describe(`Tipo: ${PLACEHOLDER_KINDS.join(', ')}. Ex.: "avatar".`),
        seed: z
          .string()
          .optional()
          .describe('Semente: o mesmo texto gera sempre a mesma imagem, ex.: "ana".'),
        width: z.number().positive().optional().describe('Largura do SVG em px, ex.: 600.'),
        height: z.number().positive().optional().describe('Altura do SVG em px, ex.: 400.'),
        label: z
          .string()
          .optional()
          .describe('Texto do logo (ou nome para as iniciais do avatar), ex.: "Acme".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeId, kind, seed, width, height, label, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
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
      const created = r.nodeId !== nodeId ? ` (imagem criada: ${r.nodeId})` : '';
      return `Placeholder ${kind} aplicado${created}; arquivo: ${r.where}.\n${summaryOf(out.doc, [r.nodeId], [nodeId])}`;
    },
  );
}
