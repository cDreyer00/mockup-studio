import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  COMPONENT_EDIT_PAGE_ID,
  exportHtml,
  exportReact,
  exportSvg,
  expandRepeaters,
  exportTailwind,
  mediaAssetRefs,
  tailwindThemeCss,
  type Document,
  type LayoutNode,
  type Node,
} from '@mockup/core';
import { assetDataUrl, safeJoin } from '../../assets.js';
import { renderTargetFor } from '../../component-view.js';
import { getLibrary } from '../../library.js';
import { encodeFrames, locateFfmpeg, type AnimatedFormat } from '../../encode.js';
import { renderUnavailableMessage } from '../../render.js';
import { copyCdnFiles, localizeCdnLinks } from '../cdnExport.js';
import { getTailwindEngine } from '@mockup/core/tailwind';
import { READ, ToolError, docIdField, type ToolContext } from '../context.js';

const MAX_INLINE_BYTES = 20 * 1024;

function effectNodes(node: Node, out: Node[] = []): Node[] {
  if (node.type === 'effect') out.push(node);
  for (const c of node.children) effectNodes(c, out);
  return out;
}

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
  for (const r of mediaAssetRefs(node)) out.add(r);
  for (const v of Object.values(node.style)) {
    for (const m of v.matchAll(/url\(\s*["']?assets\/([^"')]+)["']?\s*\)/g)) out.add(m[1]!);
  }
  for (const c of node.children) collect(c, out);
}

/** Arquivos de `assets/` usados pelos nós (imagens, fundos) e pelas fontes embutidas do documento. */
export function usedAssets(doc: Document, nodes: Node[]): string[] {
  const out = new Set<string>();
  // repetidores expandem antes: srcs vindos dos dados também entram
  for (const n of nodes) collect(expandRepeaters(n), out);
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
  const { tool, store, opts, readNode } = ctx;

  const nodeSubtree = (doc: Document, id: string): Node => readNode(doc, id).path.node;

  /**
   * Documento para exportar o nó: o expandido (instâncias concretas; ids virtuais) ou o temporário de
   * um principal. React usa o documento original para nós reais (gera um componente por principal).
   */
  const exportDocFor = (doc: Document, id: string, format: string): Document => {
    const r = readNode(doc, id);
    const real = !id.includes('/') && r.path.page.id !== COMPONENT_EDIT_PAGE_ID;
    return format === 'react' && real ? doc : r.doc;
  };

  tool(
    'export',
    {
      title: 'Exportar nós para arquivos',
      description:
        'Grava um arquivo por nó em outputDir (padrão <pasta do documento>/exports/); sobrescreve os de mesmo nome. Formatos: png, jpg, mp4, webm, gif (exigem render; os animados usam fps/duration/start e ffmpeg), svg, html, tailwind, react. Copia assets. Para só ler o código use get_code.',
      example: { nodeIds: ['fr_ab12cd34'], format: 'mp4', fps: 30, duration: 3 },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .describe('Ids dos nós a exportar, ex.: ["fr_ab12cd34"].'),
        format: z
          .enum(['png', 'jpg', 'mp4', 'webm', 'gif', 'svg', 'html', 'tailwind', 'react'])
          .describe(
            'Formato de saída: "png", "jpg", "mp4", "webm", "gif" (animados), "svg", "html", "tailwind" ou "react".',
          ),
        scale: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe('Escala para png/jpg/mp4/webm/gif: 1 (padrão), 2 ou 3, ex.: 2.'),
        fps: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Só mp4/webm/gif: quadros por segundo, 1 a 60 (padrão 30; gif 15, máximo 30).'),
        duration: z
          .number()
          .positive()
          .max(30)
          .optional()
          .describe('Só mp4/webm/gif: duração em segundos, maior que 0 e até 30 (padrão 3).'),
        start: z
          .number()
          .min(0)
          .optional()
          .describe('Só mp4/webm/gif: tempo inicial das animações em segundos (padrão 0).'),
        maxWidth: z
          .number()
          .int()
          .min(16)
          .optional()
          .describe('Só mp4/webm/gif: largura máxima em px; reduz mantendo a proporção. Ex.: 720.'),
        effects: z
          .enum(['live', 'static'])
          .optional()
          .describe(
            'Só react: "live" (padrão) recria os efeitos animados no código; "static" grava um PNG de cada efeito em assets/effects/ (exige render).',
          ),
        outputDir: z
          .string()
          .optional()
          .describe(
            'Pasta de saída absoluta, ex.: "C:/projetos/site/exports" (padrão: <pasta do documento>/exports/).',
          ),
        styles: z
          .enum(['tailwind', 'inline'])
          .optional()
          .describe('Estilos do componente react: "tailwind" (padrão) ou "inline".'),
        assetsBase: z
          .string()
          .optional()
          .describe(
            'Só react: prefixo das URLs de imagens e fontes (padrão "assets/"). Num projeto Vite com a pasta assets em public/, use "/assets/".',
          ),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({
      nodeIds,
      format,
      scale,
      outputDir,
      styles,
      assetsBase,
      fps,
      duration,
      start,
      maxWidth,
      effects,
      docId,
    }) => {
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
      const paths = nodeIds.map((n) => readNode(doc, n).path);
      const isImage = format === 'png' || format === 'jpg';
      const isAnimated = format === 'mp4' || format === 'webm' || format === 'gif';
      if ((isImage || isAnimated) && !opts.render)
        throw new ToolError(renderUnavailableMessage({ pid: process.pid, port: opts.getPort?.() }));
      if (isAnimated && !opts.render!.captureFrames)
        throw new ToolError(
          'O motor de render deste daemon não captura quadros animados, necessário para mp4, webm e gif. Use o app desktop do Mockup Studio atualizado.',
        );
      const animFps = format === 'gif' ? Math.min(fps ?? 15, 30) : (fps ?? 30);
      const animDuration = duration ?? 3;
      const extraNotes: string[] = [];
      await fs.promises.mkdir(dir, { recursive: true });
      // Código (html, tailwind, react): links /cdn do daemon viram cópias locais em assets/cdn/.
      const cdn =
        !isImage && format !== 'svg' ? localizeCdnLinks(doc, getLibrary(opts.dataDir)) : null;
      const code = cdn?.doc ?? doc;

      // Lottie .json pequeno vai embutido no HTML (abre por file://)
      const readAsset = (ref: string): string | undefined => {
        const root = store.assetsDir(id);
        const file = root ? safeJoin(root, ref) : null;
        try {
          return file ? fs.readFileSync(file, 'utf8') : undefined;
        } catch {
          return undefined;
        }
      };
      const used = new Set<string>();
      const usedComponents = new Set<string>();
      const uniq = (base: string, ext: string): string => {
        let name = `${base}${ext}`;
        for (let i = 2; used.has(name); i++) name = `${base}-${i}${ext}`;
        used.add(name);
        return name;
      };

      const written: { file: string; content?: string; replaced: boolean }[] = [];
      const write = async (name: string, data: string | Buffer, showText = false) => {
        const file = path.join(dir, name);
        const replaced = fs.existsSync(file);
        await fs.promises.writeFile(file, data);
        const text = typeof data === 'string' ? data : undefined;
        written.push({
          file,
          replaced,
          content:
            showText && text && Buffer.byteLength(text) <= MAX_INLINE_BYTES ? text : undefined,
        });
      };

      let themeCss: string | undefined;
      for (const [pi, p] of paths.entries()) {
        const node = p.node;
        const ref = nodeIds[pi]!;
        const slug = slugOf(node.name, node.id);
        if (isAnimated) {
          // componentes e ids virtuais: o render recebe o documento expandido (ou a prévia do principal)
          const animTarget = renderTargetFor(doc, ref)!;
          const file = path.join(dir, uniq(slug, `.${format}`));
          const replaced = fs.existsSync(file);
          let frames = 0;
          try {
            await encodeFrames({
              ffmpeg: locateFfmpeg(),
              format: format as AnimatedFormat,
              fps: animFps,
              out: file,
              produce: (put) =>
                opts.render!.captureFrames!(
                  {
                    doc: animTarget.doc,
                    docId: id,
                    nodeId: animTarget.nodeId,
                    assetsDir: store.assetsDir(id),
                    scale: scale ?? 1,
                    maxWidth,
                    fps: animFps,
                    duration: animDuration,
                    start: start ?? 0,
                  },
                  async (png) => {
                    frames++;
                    await put(png);
                  },
                ),
            });
          } catch (e) {
            await fs.promises.rm(file, { force: true }).catch(() => undefined);
            throw new ToolError(
              `Falha ao exportar ${format} de ${node.id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          const size = (await fs.promises.stat(file)).size;
          written.push({ file, replaced });
          extraNotes.push(
            `${path.basename(file)}: ${frames} quadro(s) a ${animFps} fps, ${animDuration} s, ${Math.max(1, Math.round(size / 1024))} KB`,
          );
        } else if (isImage) {
          const rt = renderTargetFor(doc, ref)!;
          const r = await opts.render!.capture({
            doc: rt.doc,
            docId: id,
            nodeId: rt.nodeId,
            assetsDir: store.assetsDir(id),
            scale: scale ?? 1,
            format,
          });
          await write(uniq(slug, format === 'png' ? '.png' : '.jpg'), r.data);
        } else if (format === 'svg') {
          let layout: LayoutNode | undefined;
          if (opts.render) {
            try {
              const rt = renderTargetFor(doc, ref)!;
              layout = await opts.render.measure({
                doc: rt.doc,
                docId: id,
                nodeId: rt.nodeId,
                assetsDir: store.assetsDir(id),
              });
            } catch {
              layout = undefined;
            }
          }
          const assets = store.assetsDir(id);
          const resolveImage = (src: string): string | undefined => assetDataUrl(assets, src);
          await write(
            uniq(slug, '.svg'),
            exportSvg(exportDocFor(doc, ref, 'svg'), { nodeId: node.id, layout, resolveImage }),
          );
        } else if (format === 'html') {
          await write(
            uniq(slug, '.html'),
            exportHtml(exportDocFor(code, ref, 'html'), {
              nodeIds: [node.id],
              title: node.name,
              mode: 'classes',
              readAsset,
            }),
            true,
          );
        } else if (format === 'tailwind') {
          await write(
            uniq(slug, '.tailwind.html'),
            exportTailwind(exportDocFor(code, ref, 'tailwind'), {
              nodeIds: [node.id],
              title: node.name,
              tailwind: await getTailwindEngine(doc),
              readAsset,
            }),
            true,
          );
        } else {
          // nome do componente único na exportação: também deriva os arquivos das ilhas Three.js
          let name = pascalOf(slug);
          for (let i = 2; usedComponents.has(name); i++) name = `${pascalOf(slug)}${i}`;
          usedComponents.add(name);
          const effectImages: Record<string, string> = {};
          if (effects === 'static') {
            if (!opts.render)
              throw new ToolError(
                renderUnavailableMessage({ pid: process.pid, port: opts.getPort?.() }),
              );
            for (const ef of effectNodes(node)) {
              // efeito dentro de instância: id virtual (`in_x/fx_y`) no documento expandido
              const et = renderTargetFor(doc, ef.id);
              if (!et) continue;
              const cap = await opts.render.capture({
                doc: et.doc,
                docId: id,
                nodeId: et.nodeId,
                assetsDir: store.assetsDir(id),
                scale: 1,
                format: 'png',
                time: 0,
              });
              const rel = `effects/${ef.id.replace(/\//g, '_')}.png`;
              await fs.promises.mkdir(path.join(dir, 'assets', 'effects'), { recursive: true });
              await fs.promises.writeFile(path.join(dir, 'assets', rel), cap.data);
              effectImages[ef.id] = rel;
              // o corpo do componente gerado para o principal usa o id do nó no principal
              const own = ef.id.slice(ef.id.lastIndexOf('/') + 1);
              if (own !== ef.id) effectImages[own] ??= rel;
            }
            if (Object.keys(effectImages).length)
              extraNotes.push(
                `Efeitos estáticos: ${Object.keys(effectImages).length} PNG(s) em ${path.join(dir, 'assets', 'effects')}`,
              );
          }
          const r = exportReact(exportDocFor(code, ref, 'react'), {
            nodeId: node.id,
            // O motor só serve ao Tailwind: com estilos inline nem é carregado.
            ...((styles ?? 'tailwind') === 'tailwind'
              ? { tailwind: await getTailwindEngine(doc) }
              : {}),
            styles: styles ?? 'tailwind',
            componentName: name,
            ...(assetsBase ? { assetsBase } : {}),
            ...(Object.keys(effectImages).length ? { effectImages } : {}),
          });
          await write(uniq(r.componentName, '.tsx'), r.code, true);
          for (const f of r.files ?? []) await write(f.name, f.code, true);
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
      else if (format === 'tailwind' && Object.keys(doc.tokens).length) {
        await write('theme.css', tailwindThemeCss(doc), true);
      }

      let assetsNote = '';
      if (!isImage && !isAnimated && format !== 'svg') {
        const rels = usedAssets(
          code,
          // árvore expandida: imagens dentro de instâncias também entram
          nodeIds.map((n) => readNode(code, n).path.node),
        );
        const fromCdn = new Map(
          [...(cdn?.files ?? [])].filter(([name]) => rels.includes(`cdn/${name}`)),
        );
        const copied = [
          ...(await copyAssets(
            store.assetsDir(id),
            dir,
            rels.filter((r) => !fromCdn.has(r.slice(4))),
          )),
          ...(await copyCdnFiles(fromCdn, dir)),
        ];
        if (copied.length)
          assetsNote = `\nAssets copiados para ${path.join(dir, 'assets')}: ${copied.join(', ')}`;
      }

      const lines = [`Exportado(s) ${written.length} arquivo(s) (${format}):`];
      for (const w of written) lines.push(`- ${w.file}${w.replaced ? ' (substituído)' : ''}`);
      if (assetsNote) lines.push(assetsNote.trim());
      for (const n of extraNotes) lines.push(n);
      // O código só vai na resposta enquanto o total couber no orçamento: exportar vários frames
      // não pode despejar centenas de KB no contexto do agente (use get_code por nó ou leia os arquivos).
      let budget = MAX_INLINE_BYTES;
      let omitted = 0;
      for (const w of written) {
        if (!w.content) continue;
        const size = Buffer.byteLength(w.content);
        if (size > budget) {
          omitted++;
          continue;
        }
        budget -= size;
        lines.push(`\n--- ${path.basename(w.file)} ---\n${w.content}`);
      }
      if (omitted)
        lines.push(
          `\n(${omitted} arquivo(s) de código não foram repetidos na resposta; leia-os na pasta ou use get_code(nodeId, format).)`,
        );
      return lines.join('\n');
    },
  );

  tool(
    'get_code',
    {
      title: 'Código de um nó (HTML, Tailwind ou React)',
      description:
        'Devolve na resposta o código de um nó (html, tailwind ou react) sem gravar arquivos. Para gravar arquivos e copiar assets use export.',
      example: { nodeId: 'fr_ab12cd34', format: 'react', styles: 'tailwind' },
      inputSchema: {
        nodeId: z.string().describe('Id do nó, ex.: "fr_ab12cd34".'),
        format: z
          .enum(['html', 'tailwind', 'react'])
          .describe('Formato do código: "html", "tailwind" ou "react".'),
        styles: z
          .enum(['tailwind', 'inline'])
          .optional()
          .describe('Estilos do componente react: "tailwind" (padrão) ou "inline".'),
        assetsBase: z
          .string()
          .optional()
          .describe(
            'Só react: prefixo das URLs de imagens e fontes (padrão "assets/"). Num projeto Vite com a pasta assets em public/, use "/assets/".',
          ),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeId, format, styles, assetsBase, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const node = nodeSubtree(doc, nodeId);
      const codeDoc = exportDocFor(doc, nodeId, format);
      if (format === 'html') {
        return exportHtml(codeDoc, {
          nodeIds: [nodeId],
          title: node.name,
          mode: 'classes',
          fragment: true,
        });
      }
      if (format === 'tailwind') {
        const html = exportTailwind(codeDoc, {
          nodeIds: [nodeId],
          title: node.name,
          fragment: true,
          tailwind: await getTailwindEngine(doc),
        });
        const css = Object.keys(doc.tokens).length ? tailwindThemeCss(doc) : undefined;
        return css ? `${html}\n\n/* theme.css */\n${css}` : html;
      }
      const r = exportReact(codeDoc, {
        nodeId,
        // O motor só serve ao Tailwind: com estilos inline nem é carregado.
        ...((styles ?? 'tailwind') === 'tailwind'
          ? { tailwind: await getTailwindEngine(doc) }
          : {}),
        styles: styles ?? 'tailwind',
        componentName: pascalOf(slugOf(node.name, node.id)),
        ...(assetsBase ? { assetsBase } : {}),
      });
      // o runtime dos efeitos é fixo e grande: só o nome (o export grava o arquivo)
      const extra = (r.files ?? [])
        .map((f) =>
          f.name.startsWith('mockup-effects.')
            ? `\n\n// ${f.name}: runtime dos efeitos, gravado por export(format: 'react')`
            : `\n\n// ${f.name}\n${f.code}`,
        )
        .join('');
      return (
        (r.css
          ? `// ${r.componentName}.tsx\n${r.code}\n\n/* ${(styles ?? 'tailwind') === 'tailwind' ? 'theme.css' : `${r.componentName}.css`} */\n${r.css}`
          : `// ${r.componentName}.tsx\n${r.code}`) + extra
      );
    },
  );
}
