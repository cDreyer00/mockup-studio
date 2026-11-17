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
  /** Nome base sugerido para o arquivo (sem extensão confiável). */
  hint: string;
}

export async function loadSource(source: string): Promise<Loaded> {
  const src = source.trim();
  if (src.startsWith('data:')) {
    const d = parseDataUrl(src);
    if (!d) throw new ToolError('Data URL inválida. Ex.: "data:image/png;base64,iVBORw0...".');
    if (d.bytes.length > MAX_ASSET_BYTES) throw new ToolError('A imagem passa do limite de 20 MB.');
    return { bytes: d.bytes, hint: 'imagem' };
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
        `A URL devolveu "${r.contentType}", não uma imagem. Use o endereço direto do arquivo (png, jpg, gif, webp, svg, avif).`,
      );
    }
    let hint = 'imagem';
    try {
      hint = path.basename(new URL(r.finalUrl).pathname) || hint;
    } catch {
      // mantém o padrão
    }
    return { bytes: r.bytes, hint };
  }
  if (!path.isAbsolute(src)) {
    throw new ToolError(
      `source deve ser um caminho absoluto, URL http(s) ou data URL; recebido "${src}".`,
    );
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(src);
  } catch {
    throw new ToolError(`Arquivo não encontrado: ${src}`);
  }
  if (!st.isFile()) throw new ToolError(`"${src}" não é um arquivo.`);
  if (st.size > MAX_ASSET_BYTES) throw new ToolError('A imagem passa do limite de 20 MB.');
  return { bytes: await fs.promises.readFile(src), hint: path.basename(src) };
}

export function registerImageTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  tool(
    'insert_image',
    {
      title: 'Inserir imagem',
      description:
        'Insere uma imagem (nó img) em parentId a partir de caminho absoluto, URL http(s) ou data URL; valida os bytes e copia para assets/. Sem width usa o tamanho intrínseco.',
      example: {
        parentId: 'fr_ab12cd34',
        source: 'C:/fotos/capa.png',
        alt: 'Capa',
        styles: { width: '320px' },
      },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "fr_ab12cd34".'),
        source: z
          .string()
          .describe(
            'Caminho absoluto, URL http(s) ou data URL da imagem. Ex.: "C:/fotos/capa.png".',
          ),
        alt: z
          .string()
          .optional()
          .describe('Texto alternativo (atributo alt), ex.: "Foto de capa".'),
        styles: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Estilos CSS, ex.: { "width": "320px", "border-radius": "12px", "object-fit": "cover" }.',
          ),
        name: z.string().optional().describe('Nome da camada, ex.: "Foto de capa".'),
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
    async ({ parentId, source, alt, styles, name, index, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const { bytes, hint } = await loadSource(source);
      const info: ImageInfo | null = detectImage(bytes);
      if (!info) {
        throw new ToolError(
          'O conteúdo não é uma imagem reconhecida (PNG, JPEG, GIF, WebP, SVG ou AVIF). Confira o arquivo ou a URL.',
        );
      }
      const assets = store.assetsDir(id);
      let src: string;
      let where: string;
      if (assets) {
        const stem = hint.replace(/\.[^.]*$/, '') || 'imagem';
        const safe = sanitizeAssetName(`${stem}${info.ext}`);
        const file = await writeAsset(assets, `${safe.base}${safe.ext}`, bytes);
        src = file;
        where = `assets/${file}`;
      } else {
        if (bytes.length > MAX_DATA_URL_BYTES) {
          throw new ToolError(
            'O documento ainda não tem caminho em disco e a imagem passa de 2 MB para embutir. Salve o documento (create_document ou Salvar como) e tente de novo.',
          );
        }
        src = `data:${info.mime};base64,${bytes.toString('base64')}`;
        where = 'data URL embutida';
      }
      const st = { ...(styles ?? {}) };
      if (!st['width'] && info.width && info.height) {
        st['width'] = `${info.width}px`;
        if (!st['height']) st['height'] = `${info.height}px`;
      }
      const node = createNodeFromTag('img', {
        name: name ?? 'Imagem',
        src,
        attrs: alt !== undefined ? { alt } : {},
        styles: st,
      });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_image');
      const dims = info.width ? ` ${info.width}x${info.height} px` : '';
      return `Imagem inserida: ${node.id} (${info.mime}${dims}, ${Math.max(1, Math.round(bytes.length / 1024))} KB) em ${parentId}; arquivo: ${where}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'insert_icon',
    {
      title: 'Inserir ícone',
      description:
        'Insere um ícone (nó svg) do Lucide ou Heroicons. name: "arrow-right", "lucide/..." ou "heroicons/..." (sem kit: Lucide, depois Heroicons). Heroicons sem sufixo = outline; "-solid", "-20-solid", "-16-solid" = preenchidos. Sem color usa a cor do texto do pai. Veja search_icons.',
      example: {
        parentId: 'el_ab12cd34',
        name: 'heroicons/arrow-right',
        size: 24,
        color: '#0f172a',
      },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "el_ab12cd34".'),
        name: z
          .string()
          .describe('Nome do ícone, ex.: "arrow-right", "lucide/search", "heroicons/user-solid".'),
        kit: z
          .enum(['lucide', 'heroicons'])
          .optional()
          .describe(
            'Kit, ex.: "heroicons" (padrão: pelo prefixo do nome; sem prefixo, Lucide e depois Heroicons).',
          ),
        size: z.number().positive().optional().describe('Tamanho em px, ex.: 24 (padrão 24).'),
        color: z
          .string()
          .optional()
          .describe('Cor do ícone, ex.: "#0f172a" (padrão: cor do texto do pai).'),
        stroke_width: z
          .number()
          .positive()
          .max(6)
          .optional()
          .describe(
            'Espessura do traço (só Lucide e Heroicons outline), maior que 0 e até 6, ex.: 1.5 (padrão: 2 no Lucide, 1.5 no Heroicons).',
          ),
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
    async ({ parentId, name, kit, size, color, stroke_width, index, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireNode(doc, parentId);
      const ref = await resolveIcon(name, kit);
      if (!ref) {
        const sug = await suggestSimilarIcons(name, { kit, limit: 6 });
        throw new ToolError(
          `Ícone "${name}" não existe${kit ? ` no kit ${kit}` : ' (Lucide, Heroicons)'}.${sug.length ? ` Parecidos: ${sug.join(', ')}.` : ''} Use search_icons(query) para procurar.`,
        );
      }
      let stroke = color?.trim();
      if (stroke) {
        if (!/^[#a-zA-Z0-9(),.%\s/-]+$/.test(stroke))
          throw new ToolError(`Cor inválida: "${color}". Ex.: "#6c5ce7" ou "rgb(0 0 0)".`);
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
        name: `Ícone ${label}`,
        svg,
        styles: { width: `${px}px`, height: `${px}px` },
      });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_icon');
      const ignored =
        stroke_width !== undefined && !isStrokeIcon(ref)
          ? ' stroke_width ignorado: ícone preenchido (solid).'
          : '';
      return `Ícone "${label}" inserido: ${node.id} (${px}px, cor ${stroke}) em ${parentId}.${ignored}\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'search_icons',
    {
      title: 'Buscar ícones (Lucide, Heroicons)',
      description:
        'Busca ícones offline por nome ou tag (em inglês) no Lucide, no Heroicons ou nos dois (kit "all", padrão). Devolve linhas "- kit/nome (tags)" para usar em insert_icon. No Heroicons as tags são o estilo: outline, solid, 20-solid, 16-solid.',
      example: { query: 'cart', kit: 'all', limit: 10 },
      inputSchema: {
        query: z.string().min(1).describe('Termo de busca, ex.: "cart".'),
        kit: z
          .enum(['lucide', 'heroicons', 'all'])
          .optional()
          .describe('Kit a pesquisar, ex.: "heroicons" (padrão "all").'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Máximo de resultados, de 1 a 100, ex.: 10 (padrão 20).'),
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
        return `Nenhum ícone para "${query}".${sug.length ? ` Parecidos: ${sug.join(', ')}.` : ''}`;
      }
      return (
        `${hits.length} ícone(s) para "${query}":\n` +
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
