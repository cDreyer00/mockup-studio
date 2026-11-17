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

/** File name from the node name: `Desktop 1440` → `desktop-1440`. */
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

/** Files from `assets/` used by the nodes (images, backgrounds) and by the document's embedded fonts. */
export function usedAssets(doc: Document, nodes: Node[]): string[] {
  const out = new Set<string>();
  // repeaters expand first: srcs coming from the data are included too
  for (const n of nodes) collect(expandRepeaters(n), out);
  for (const f of doc.fonts) for (const file of f.files ?? []) out.add(file);
  return [...out];
}

/** Copies the assets to `<outputDir>/assets/`; returns the relative paths copied. */
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
      // missing asset: the export goes on, the reference stays pending
    }
  }
  return copied;
}

export function registerExportTools(ctx: ToolContext): void {
  const { tool, store, opts, readNode } = ctx;

  const nodeSubtree = (doc: Document, id: string): Node => readNode(doc, id).path.node;

  /**
   * Document to export the node from: the expanded one (concrete instances; virtual ids) or the temporary one of
   * a main component. React uses the original document for real nodes (generates one component per main component).
   */
  const exportDocFor = (doc: Document, id: string, format: string): Document => {
    const r = readNode(doc, id);
    const real = !id.includes('/') && r.path.page.id !== COMPONENT_EDIT_PAGE_ID;
    return format === 'react' && real ? doc : r.doc;
  };

  tool(
    'export',
    {
      title: 'Export nodes to files',
      description:
        'Writes one file per node to outputDir (default <document folder>/exports/); overwrites files with the same name. Formats: png, jpg, mp4, webm, gif (need render; animated ones use fps/duration/start and ffmpeg), svg, html, tailwind, react. Copies assets. To just read the code use get_code.',
      example: { nodeIds: ['fr_ab12cd34'], format: 'mp4', fps: 30, duration: 3 },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .describe('Ids of the nodes to export, e.g. ["fr_ab12cd34"].'),
        format: z
          .enum(['png', 'jpg', 'mp4', 'webm', 'gif', 'svg', 'html', 'tailwind', 'react'])
          .describe(
            'Output format: "png", "jpg", "mp4", "webm", "gif" (animated), "svg", "html", "tailwind" or "react".',
          ),
        scale: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe('Scale for png/jpg/mp4/webm/gif: 1 (default), 2 or 3, e.g. 2.'),
        fps: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe(
            'mp4/webm/gif only: frames per second, 1 to 60 (default 30; gif 15, maximum 30).',
          ),
        duration: z
          .number()
          .positive()
          .max(30)
          .optional()
          .describe(
            'mp4/webm/gif only: duration in seconds, greater than 0 and up to 30 (default 3).',
          ),
        start: z
          .number()
          .min(0)
          .optional()
          .describe('mp4/webm/gif only: start time of the animations in seconds (default 0).'),
        maxWidth: z
          .number()
          .int()
          .min(16)
          .optional()
          .describe(
            'mp4/webm/gif only: maximum width in px; scales down keeping the aspect ratio. E.g. 720.',
          ),
        effects: z
          .enum(['live', 'static'])
          .optional()
          .describe(
            'react only: "live" (default) recreates the animated effects in code; "static" writes a PNG of each effect to assets/effects/ (needs render).',
          ),
        outputDir: z
          .string()
          .optional()
          .describe(
            'Absolute output folder, e.g. "C:/projects/site/exports" (default: <document folder>/exports/).',
          ),
        styles: z
          .enum(['tailwind', 'inline'])
          .optional()
          .describe('Styles of the react component: "tailwind" (default) or "inline".'),
        assetsBase: z
          .string()
          .optional()
          .describe(
            'react only: prefix of the image and font URLs (default "assets/"). In a Vite project with the assets folder in public/, use "/assets/".',
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
          throw new ToolError(`outputDir must be an absolute path, got "${dir}".`);
      } else {
        if (!info.path)
          throw new ToolError(
            'The document has no path on disk yet. Pass outputDir (absolute path) or save the document first.',
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
          "This daemon's render engine does not capture animated frames, which mp4, webm and gif need. Use the updated Mockup Studio desktop app.",
        );
      const animFps = format === 'gif' ? Math.min(fps ?? 15, 30) : (fps ?? 30);
      const animDuration = duration ?? 3;
      const extraNotes: string[] = [];
      await fs.promises.mkdir(dir, { recursive: true });
      // Code (html, tailwind, react): the daemon's /cdn links become local copies in assets/cdn/.
      const cdn =
        !isImage && format !== 'svg' ? localizeCdnLinks(doc, getLibrary(opts.dataDir)) : null;
      const code = cdn?.doc ?? doc;

      // A small Lottie .json is embedded in the HTML (opens over file://)
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
          // components and virtual ids: the render receives the expanded document (or the main component's preview)
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
              `Failed to export ${format} of ${node.id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          const size = (await fs.promises.stat(file)).size;
          written.push({ file, replaced });
          extraNotes.push(
            `${path.basename(file)}: ${frames} frame(s) at ${animFps} fps, ${animDuration} s, ${Math.max(1, Math.round(size / 1024))} KB`,
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
          // component name unique within the export: also used to derive the Three.js island files
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
              // effect inside an instance: virtual id (`in_x/fx_y`) in the expanded document
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
              // the body of the component generated for the main component uses the node id inside the main component
              const own = ef.id.slice(ef.id.lastIndexOf('/') + 1);
              if (own !== ef.id) effectImages[own] ??= rel;
            }
            if (Object.keys(effectImages).length)
              extraNotes.push(
                `Static effects: ${Object.keys(effectImages).length} PNG(s) in ${path.join(dir, 'assets', 'effects')}`,
              );
          }
          const r = exportReact(exportDocFor(code, ref, 'react'), {
            nodeId: node.id,
            // The engine only serves Tailwind: with inline styles it is not even loaded.
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
          // expanded tree: images inside instances are included too
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
          assetsNote = `\nAssets copied to ${path.join(dir, 'assets')}: ${copied.join(', ')}`;
      }

      const lines = [`Exported ${written.length} file(s) (${format}):`];
      for (const w of written) lines.push(`- ${w.file}${w.replaced ? ' (replaced)' : ''}`);
      if (assetsNote) lines.push(assetsNote.trim());
      for (const n of extraNotes) lines.push(n);
      // The code only goes in the response while the total fits the budget: exporting several frames
      // must not dump hundreds of KB into the agent's context (use get_code per node or read the files).
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
          `\n(${omitted} code file(s) were not repeated in the response; read them in the folder or use get_code(nodeId, format).)`,
        );
      return lines.join('\n');
    },
  );

  tool(
    'get_code',
    {
      title: 'Code of a node (HTML, Tailwind or React)',
      description:
        'Returns the code of a node (html, tailwind or react) in the response without writing files. To write files and copy assets use export.',
      example: { nodeId: 'fr_ab12cd34', format: 'react', styles: 'tailwind' },
      inputSchema: {
        nodeId: z.string().describe('Node id, e.g. "fr_ab12cd34".'),
        format: z
          .enum(['html', 'tailwind', 'react'])
          .describe('Code format: "html", "tailwind" or "react".'),
        styles: z
          .enum(['tailwind', 'inline'])
          .optional()
          .describe('Styles of the react component: "tailwind" (default) or "inline".'),
        assetsBase: z
          .string()
          .optional()
          .describe(
            'react only: prefix of the image and font URLs (default "assets/"). In a Vite project with the assets folder in public/, use "/assets/".',
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
        // The engine only serves Tailwind: with inline styles it is not even loaded.
        ...((styles ?? 'tailwind') === 'tailwind'
          ? { tailwind: await getTailwindEngine(doc) }
          : {}),
        styles: styles ?? 'tailwind',
        componentName: pascalOf(slugOf(node.name, node.id)),
        ...(assetsBase ? { assetsBase } : {}),
      });
      // the effects runtime is fixed and large: only the name (export writes the file)
      const extra = (r.files ?? [])
        .map((f) =>
          f.name.startsWith('mockup-effects.')
            ? `\n\n// ${f.name}: effects runtime, written by export(format: 'react')`
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
