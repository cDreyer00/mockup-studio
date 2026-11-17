import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createNodeFromTag, getComputedLike } from '@mockup/core';
import { detectImage, fetchBytes, parseDataUrl, writeAsset, type ImageInfo } from '../../assets.js';
import { MAX_ASSET_BYTES, sanitizeAssetName } from '../../http.js';
import {
  buildIconSvg,
  loadIcons,
  resolveIconName,
  searchIconNames,
  suggestIcons,
} from '../../icons.js';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

const MAX_DATA_URL_BYTES = 2 * 1024 * 1024;

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
      title: 'Inserir ícone Lucide',
      description:
        'Insere um ícone Lucide (nó svg). name em kebab-case; sem color usa a cor de texto do pai. Use search_icons para achar nomes.',
      example: { parentId: 'el_ab12cd34', name: 'arrow-right', size: 24, color: '#0f172a' },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "el_ab12cd34".'),
        name: z.string().describe('Nome do ícone Lucide, ex.: "arrow-right", "search", "user".'),
        size: z.number().positive().optional().describe('Tamanho em px, ex.: 24 (padrão 24).'),
        color: z
          .string()
          .optional()
          .describe('Cor do traço, ex.: "#0f172a" (padrão: cor do texto do pai).'),
        stroke_width: z
          .number()
          .positive()
          .max(6)
          .optional()
          .describe('Espessura do traço, maior que 0 e até 6, ex.: 1.5 (padrão 2).'),
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
    async ({ parentId, name, size, color, stroke_width, index, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireNode(doc, parentId);
      const data = await loadIcons();
      const canonical = resolveIconName(data, name);
      if (!canonical) {
        const sug = suggestIcons(data, name, 5);
        throw new ToolError(
          `Ícone "${name}" não existe no Lucide.${sug.length ? ` Parecidos: ${sug.join(', ')}.` : ''} Use search_icons(query) para procurar.`,
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
      const svg = buildIconSvg(data.nodes[canonical]!, {
        size: px,
        color: stroke,
        strokeWidth: stroke_width ?? 2,
      });
      const node = createNodeFromTag('svg', {
        name: `Ícone ${canonical}`,
        svg,
        styles: { width: `${px}px`, height: `${px}px` },
      });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'insert_icon');
      return `Ícone "${canonical}" inserido: ${node.id} (${px}px, cor ${stroke}) em ${parentId}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'search_icons',
    {
      title: 'Buscar ícones Lucide',
      description:
        'Busca ícones Lucide por nome ou tag (em inglês). Devolve nomes kebab-case para usar em insert_icon.',
      example: { query: 'cart', limit: 10 },
      inputSchema: {
        query: z.string().min(1).describe('Termo de busca, ex.: "cart".'),
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
    async ({ query, limit }) => {
      const data = await loadIcons();
      const hits = searchIconNames(data, query, limit ?? 20);
      if (!hits.length) {
        const sug = suggestIcons(data, query, 5);
        return `Nenhum ícone para "${query}".${sug.length ? ` Parecidos: ${sug.join(', ')}.` : ''}`;
      }
      return (
        `${hits.length} ícone(s) para "${query}":\n` +
        hits
          .map((h) => `- ${h.name}${h.tags.length ? ` (${h.tags.slice(0, 4).join(', ')})` : ''}`)
          .join('\n')
      );
    },
  );
}
