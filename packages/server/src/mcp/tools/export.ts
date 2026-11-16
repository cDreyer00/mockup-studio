import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as core from '@mockup/core';
import type { Document, LayoutNode, Node } from '@mockup/core';
import { safeJoin } from '../../assets.js';
import { RENDER_UNAVAILABLE } from '../../render.js';
import { READ, ToolError, docIdField, type ToolContext } from '../context.js';

const MAX_INLINE_BYTES = 20 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

/* Opções ainda não tipadas em todas as versões do core (fragment, cdn): chamamos via tipos soltos. */
type Loose<R> = (doc: Document, opts: Record<string, unknown>) => R;
const exportHtml = core.exportHtml as unknown as Loose<string>;
const exportTailwind = core.exportTailwind as unknown as Loose<string>;
const exportReact = core.exportReact as unknown as Loose<{
  componentName: string;
  code: string;
  css?: string;
}>;
const exportSvg = core.exportSvg as unknown as Loose<string>;
const tailwindThemeCss = (core as unknown as { tailwindThemeCss?: (doc: Document) => string })
  .tailwindThemeCss;

/** Nome de arquivo a partir do nome do nó: `Desktop 1440` → `desktop-1440`. */
export function slugOf(name: string, fallback: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

export function pascalOf(slug: string): string {
  const s = slug
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^[A-Za-z]/.test(s) ? s : `C${s}`;
}

function collect(node: Node, out: Set<string>): void {
  if (node.src && !node.src.startsWith('data:') && !/^[a-z]+:\/\//i.test(node.src))
    out.add(node.src);
  for (const v of Object.values(node.style)) {
    for (const m of v.matchAll(/url\(\s*["']?assets\/([^"')]+)["']?\s*\)/g)) out.add(m[1]!);
  }
  for (const c of node.children) collect(c, out);
}

/** Arquivos de `assets/` usados pelos nós (imagens, fundos) e pelas fontes embutidas do documento. */
export function usedAssets(doc: Document, nodes: Node[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) collect(n, out);
  for (const f of doc.fonts) for (const file of f.files ?? []) out.add(file);
  return [...out];
}

/** Copia os assets para `<outputDir>/assets/`; devolve os relativos copiados. */
export async function copyAssets(
  assetsDir: string | null,
  outputDir: string,
  rels: string[],
): Promise<string[]> {
  if (!assetsDir) return [];
  const copied: string[] = [];
  for (const rel of rels) {
    const src = safeJoin(assetsDir, rel);
    const dst = safeJoin(path.join(outputDir, 'assets'), rel);
    if (!src || !dst) continue;
    try {
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      await fs.promises.copyFile(src, dst);
      copied.push(rel);
    } catch {
      // asset ausente: o export segue, a referência fica pendente
    }
  }
  return copied;
}

export function registerExportTools(ctx: ToolContext): void {
  const { tool, store, opts, requireNode } = ctx;

  const nodeSubtree = (doc: Document, id: string): Node => requireNode(doc, id).node;

  tool(
    'export',
    {
      title: 'Exportar nós para arquivos',
      description:
        'Grava um arquivo por nó em outputDir (padrão: <pasta do documento>/exports/). Formatos: png, jpg (exigem render), svg, html (CSS em classes), ' +
        'tailwind (HTML com classes Tailwind v4) e react (componente .tsx; styles "tailwind" ou "inline"). Para html/tailwind/react copia as imagens e fontes ' +
        'usadas para <outputDir>/assets/. Devolve os caminhos gravados e, para código, o conteúdo (se pequeno). Para só ler o código sem gravar, use get_code.',
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .describe('Ids dos nós a exportar, ex.: ["fr_ab12cd34"].'),
        format: z.enum(['png', 'jpg', 'svg', 'html', 'tailwind', 'react']).describe('Formato.'),
        scale: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe('Escala para png/jpg (padrão 1).'),
        outputDir: z
          .string()
          .optional()
          .describe('Pasta de saída absoluta (padrão: <pasta do documento>/exports/).'),
        styles: z
          .enum(['tailwind', 'inline'])
          .optional()
          .describe('Estilos do componente react (padrão tailwind).'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ nodeIds, format, scale, outputDir, styles, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const info = store.getInfo(id);
      let dir = outputDir;
      if (dir) {
        if (!path.isAbsolute(dir))
          throw new ToolError(`outputDir deve ser um caminho absoluto, recebido "${dir}".`);
      } else {
        if (!info.path)
          throw new ToolError(
            'O documento ainda não tem caminho em disco. Informe outputDir (caminho absoluto) ou salve o documento antes.',
          );
        dir = path.join(path.dirname(info.path), 'exports');
      }
      const paths = nodeIds.map((n) => requireNode(doc, n));
      const isImage = format === 'png' || format === 'jpg';
      if (isImage && !opts.render) throw new ToolError(RENDER_UNAVAILABLE);
      await fs.promises.mkdir(dir, { recursive: true });

      const used = new Set<string>();
      const uniq = (base: string, ext: string): string => {
        let name = `${base}${ext}`;
        for (let i = 2; used.has(name); i++) name = `${base}-${i}${ext}`;
        used.add(name);
        return name;
      };

      const written: { file: string; content?: string }[] = [];
      const write = async (name: string, data: string | Buffer, showText = false) => {
        const file = path.join(dir, name);
        await fs.promises.writeFile(file, data);
        const text = typeof data === 'string' ? data : undefined;
        written.push({
          file,
          content:
            showText && text && Buffer.byteLength(text) <= MAX_INLINE_BYTES ? text : undefined,
        });
      };

      let themeCss: string | undefined;
      for (const p of paths) {
        const node = p.node;
        const slug = slugOf(node.name, node.id);
        if (isImage) {
          const r = await opts.render!.capture({
            doc,
            docId: id,
            nodeId: node.id,
            scale: scale ?? 1,
            format,
          });
          await write(uniq(slug, format === 'png' ? '.png' : '.jpg'), r.data);
        } else if (format === 'svg') {
          let layout: LayoutNode | undefined;
          if (opts.render) {
            try {
              layout = await opts.render.measure({ doc, docId: id, nodeId: node.id });
            } catch {
              layout = undefined;
            }
          }
          const assets = store.assetsDir(id);
          const resolveImage = (src: string): string | undefined => {
            if (src.startsWith('data:')) return src;
            if (!assets) return undefined;
            const target = safeJoin(assets, src);
            const mime = target ? IMAGE_MIME[path.extname(target).toLowerCase()] : undefined;
            if (!target || !mime) return undefined;
            try {
              return `data:${mime};base64,${fs.readFileSync(target).toString('base64')}`;
            } catch {
              return undefined;
            }
          };
          await write(
            uniq(slug, '.svg'),
            exportSvg(doc, { nodeId: node.id, layout, resolveImage }),
          );
        } else if (format === 'html') {
          await write(
            uniq(slug, '.html'),
            exportHtml(doc, { nodeIds: [node.id], title: node.name, mode: 'classes' }),
            true,
          );
        } else if (format === 'tailwind') {
          await write(
            uniq(slug, '.tailwind.html'),
            exportTailwind(doc, { nodeIds: [node.id], title: node.name }),
            true,
          );
        } else {
          const name = pascalOf(slug);
          const r = exportReact(doc, {
            nodeId: node.id,
            styles: styles ?? 'tailwind',
            componentName: name,
          });
          await write(uniq(r.componentName, '.tsx'), r.code, true);
          if (r.css) {
            if ((styles ?? 'tailwind') === 'tailwind') {
              themeCss ??= r.css;
            } else {
              await write(uniq(r.componentName, '.css'), r.css, true);
            }
          }
        }
      }
      if (themeCss) await write('theme.css', themeCss, true);
      else if (format === 'tailwind' && tailwindThemeCss && Object.keys(doc.tokens).length) {
        await write('theme.css', tailwindThemeCss(doc), true);
      }

      let assetsNote = '';
      if (!isImage && format !== 'svg') {
        const copied = await copyAssets(
          store.assetsDir(id),
          dir,
          usedAssets(
            doc,
            paths.map((p) => p.node),
          ),
        );
        if (copied.length)
          assetsNote = `\nAssets copiados para ${path.join(dir, 'assets')}: ${copied.join(', ')}`;
      }

      const lines = [`Exportado(s) ${written.length} arquivo(s) (${format}):`];
      for (const w of written) lines.push(`- ${w.file}`);
      if (assetsNote) lines.push(assetsNote.trim());
      for (const w of written) {
        if (w.content) lines.push(`\n--- ${path.basename(w.file)} ---\n${w.content}`);
      }
      return lines.join('\n');
    },
  );

  tool(
    'get_code',
    {
      title: 'Código de um nó (HTML, Tailwind ou React)',
      description:
        'Devolve o código do nó sem gravar arquivos. html: fragmento com o CSS necessário; tailwind: fragmento com classes Tailwind v4; ' +
        'react: componente .tsx (styles "tailwind" ou "inline") e o CSS, se houver. Para gravar arquivos e copiar assets use export.',
      inputSchema: {
        nodeId: z.string().describe('Id do nó, ex.: "fr_ab12cd34".'),
        format: z.enum(['html', 'tailwind', 'react']).describe('Formato do código.'),
        styles: z
          .enum(['tailwind', 'inline'])
          .optional()
          .describe('Estilos do componente react (padrão tailwind).'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, format, styles, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const node = nodeSubtree(doc, nodeId);
      if (format === 'html') {
        return exportHtml(doc, {
          nodeIds: [nodeId],
          title: node.name,
          mode: 'classes',
          fragment: true,
        });
      }
      if (format === 'tailwind') {
        const html = exportTailwind(doc, { nodeIds: [nodeId], title: node.name, fragment: true });
        const css =
          tailwindThemeCss && Object.keys(doc.tokens).length ? tailwindThemeCss(doc) : undefined;
        return css ? `${html}\n\n/* theme.css */\n${css}` : html;
      }
      const r = exportReact(doc, {
        nodeId,
        styles: styles ?? 'tailwind',
        componentName: pascalOf(slugOf(node.name, node.id)),
      });
      return r.css
        ? `// ${r.componentName}.tsx\n${r.code}\n\n/* ${(styles ?? 'tailwind') === 'tailwind' ? 'theme.css' : `${r.componentName}.css`} */\n${r.css}`
        : `// ${r.componentName}.tsx\n${r.code}`;
    },
  );
}
