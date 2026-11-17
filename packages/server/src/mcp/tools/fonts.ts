import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FONT_EXTS, type FontRef } from '@mockup/core';
import { fetchBytes, writeAsset } from '../../assets.js';
import {
  MODERN_UA,
  fontFamilyCss,
  fontSlug,
  googleCssUrl,
  guessFontStyle,
  listSystemFonts,
  parseGoogleCss,
} from '../../fonts.js';
import { MAX_ASSET_BYTES } from '../../http.js';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

interface FontFile {
  bytes: Buffer;
  ext: string;
  weight: number;
  /** Highest weight covered when the file is a variable font (range `weight`..`weightMax`). */
  weightMax?: number;
  style: 'normal' | 'italic';
}

/** Format preference when the font ships the same weight/style in several: woff2 > woff > ttf/otf. */
const FORMAT_RANK: Record<string, number> = { woff2: 0, woff: 1, ttf: 2, otf: 2 };

/** One file per weight/style, in the best available format. */
export function dedupeFormats(files: FontFile[]): FontFile[] {
  const best = new Map<string, FontFile>();
  for (const f of files) {
    const key = `${f.weight}/${f.style}`;
    const cur = best.get(key);
    if (!cur || (FORMAT_RANK[f.ext] ?? 9) < (FORMAT_RANK[cur.ext] ?? 9)) best.set(key, f);
  }
  return [...best.values()];
}

/**
 * Variable font: Google returns the same file for every requested weight. If, in each style, all
 * files have the same content, each style becomes a single one, covering the range from the lowest
 * to the highest weight. If any style cannot be merged (static fonts or a single weight), nothing changes.
 */
export function mergeIdenticalFiles(files: FontFile[]): FontFile[] {
  if (files.length < 2) return files;
  const out: FontFile[] = [];
  for (const style of ['normal', 'italic'] as const) {
    const group = files.filter((f) => f.style === style);
    const first = group[0];
    if (!first) continue;
    // Merge only if every present style can be merged: the document's `weights` list
    // must be one range per file or one weight per file, never a mix of the two.
    if (group.length < 2 || !group.every((f) => f.bytes.equals(first.bytes))) return files;
    const ws = group.map((f) => f.weight);
    out.push({ ...first, weight: Math.min(...ws), weightMax: Math.max(...ws) });
  }
  return out;
}

/** Family slug; if another family in the document yields the same slug, appends a stable suffix. */
export function uniqueSlug(family: string, otherFamilies: string[]): string {
  const slug = fontSlug(family);
  if (!otherFamilies.some((o) => fontSlug(o) === slug)) return slug;
  return `${slug}-${createHash('sha1').update(family.toLowerCase()).digest('hex').slice(0, 4)}`;
}

/**
 * Writes the font as `<slug>-<weight>-<style>-<hash8>.<ext>` (content hash): the name changes when
 * the font changes and never overwrites an existing file. Identical content reuses the file.
 */
async function writeFontFile(dir: string, slug: string, f: FontFile): Promise<string> {
  const hash = createHash('sha256').update(f.bytes).digest('hex').slice(0, 8);
  const range = f.weightMax && f.weightMax !== f.weight ? `${f.weight}-${f.weightMax}` : f.weight;
  const name = `${slug}-${range}-${f.style}-${hash}.${f.ext}`;
  const file = path.join(dir, name);
  try {
    if ((await fs.promises.readFile(file)).equals(f.bytes)) return name;
  } catch {
    // does not exist: write below
  }
  return writeAsset(dir, name, f.bytes);
}

const fontExt = (file: string): string => path.extname(file).toLowerCase().replace('.', '');

async function filesFromPath(source: string, weights?: number[]): Promise<FontFile[]> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(source);
  } catch {
    throw new ToolError(`Path not found: ${source}`);
  }
  const list = st.isDirectory()
    ? (await fs.promises.readdir(source))
        .filter((f) => FONT_EXTS.includes(fontExt(f)))
        .sort()
        .map((f) => path.join(source, f))
    : [source];
  if (!list.length) throw new ToolError(`No font file (${FONT_EXTS.join(', ')}) in ${source}.`);
  const out: FontFile[] = [];
  for (const file of list) {
    const ext = fontExt(file);
    if (!FONT_EXTS.includes(ext))
      throw new ToolError(`Unsupported extension in ${file}; use ${FONT_EXTS.join(', ')}.`);
    const g = guessFontStyle(file);
    const weight = !st.isDirectory() && weights?.length ? weights[0]! : g.weight;
    if (st.isDirectory() && weights?.length && !weights.includes(weight)) continue;
    const s = await fs.promises.stat(file);
    if (s.size > MAX_ASSET_BYTES) throw new ToolError(`${file} exceeds the 20 MB limit.`);
    out.push({ bytes: await fs.promises.readFile(file), ext, weight, style: g.style });
  }
  if (!out.length)
    throw new ToolError(
      `No file in ${source} matches the weights ${weights?.join(', ')}. Weights are inferred from the file name (Regular, Bold, Light...).`,
    );
  return out;
}

async function filesFromUrl(url: string, weights?: number[]): Promise<FontFile[]> {
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const ext = fontExt(pathname);
  if (!FONT_EXTS.includes(ext))
    throw new ToolError(
      `The URL must point to a font file (${FONT_EXTS.join(', ')}); received "${pathname}".`,
    );
  let r;
  try {
    r = await fetchBytes(url, { maxBytes: MAX_ASSET_BYTES, timeoutMs: 30_000 });
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : String(e));
  }
  const g = guessFontStyle(pathname);
  return [{ bytes: r.bytes, ext, weight: weights?.[0] ?? g.weight, style: g.style }];
}

async function filesFromGoogle(family: string, weights: number[]): Promise<FontFile[]> {
  const cssUrl = googleCssUrl(family, weights);
  let css: string;
  try {
    css = (
      await fetchBytes(cssUrl, {
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 20_000,
        headers: { 'User-Agent': MODERN_UA },
      })
    ).bytes.toString('utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ToolError(
      /HTTP 400|HTTP 404/.test(msg)
        ? `Google Fonts does not have the family "${family}" with the weights ${weights.join(', ')}. Check the name (e.g. "Inter", "Playfair Display") and the available weights.`
        : msg,
    );
  }
  const faces = parseGoogleCss(css).filter((f) => f.subset === 'latin');
  if (!faces.length)
    throw new ToolError(`Google Fonts did not return the latin subset of "${family}".`);
  const out: FontFile[] = [];
  for (const f of faces) {
    let r;
    try {
      r = await fetchBytes(f.url, { maxBytes: MAX_ASSET_BYTES, timeoutMs: 30_000 });
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : String(e));
    }
    out.push({
      bytes: r.bytes,
      ext: fontExt(new URL(f.url).pathname) || 'woff2',
      weight: f.weight,
      style: f.style === 'italic' ? 'italic' : 'normal',
    });
  }
  return out;
}

export function registerFontTools(ctx: ToolContext): void {
  const { tool, store } = ctx;

  const embedded = (docId: string | undefined, family: string): FontRef | undefined => {
    const doc = store.get(store.resolveDocId(docId));
    return doc.fonts.find((f) => f.family.toLowerCase() === family.toLowerCase());
  };

  tool(
    'list_fonts',
    {
      title: 'List fonts',
      description:
        'Lists the fonts embedded in the document and those installed on the system, with a name filter. To use another font, use add_font.',
      example: { query: 'inter' },
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Name filter (contains, case-insensitive), e.g. "inter".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Maximum system fonts listed, from 1 to 500, e.g. 20 (default 50).'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ query, limit, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const q = query?.trim().toLowerCase();
      const match = (f: string) => !q || f.toLowerCase().includes(q);
      const embeddedNames = new Set(doc.fonts.map((f) => f.family.toLowerCase()));
      const lines: string[] = [];
      const docFonts = doc.fonts.filter((f) => match(f.family));
      lines.push(`In the document (${docFonts.length}):`);
      for (const f of docFonts) {
        const w = f.weights?.length ? ` weights ${[...new Set(f.weights)].join(', ')}` : '';
        lines.push(`- ${f.family} [${f.source === 'local' ? 'local' : 'embedded'}]${w}`);
      }
      const sys = (await listSystemFonts()).filter((f) => match(f.family));
      const max = limit ?? 50;
      lines.push(`On the system (${sys.length}${sys.length > max ? `, showing ${max}` : ''}):`);
      for (const f of sys.slice(0, max)) {
        lines.push(
          `- ${f.family}${embeddedNames.has(f.family.toLowerCase()) ? ' [embedded in the document]' : ''}`,
        );
      }
      if (!sys.length) lines.push('(no system font found for this filter, or listing unavailable)');
      return lines.join('\n');
    },
  );

  tool(
    'get_font_info',
    {
      title: 'Font info',
      description:
        'Tells whether the font is installed on the system, embedded in the document and how to use it in font-family.',
      example: { family: 'Inter' },
      inputSchema: {
        family: z.string().describe('Family name, e.g. "Inter".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ family, docId }) => {
      const sys = (await listSystemFonts()).find(
        (f) => f.family.toLowerCase() === family.trim().toLowerCase(),
      );
      const emb = embedded(docId, family);
      const lines = [`Font "${family}":`];
      if (sys) {
        lines.push(
          `- System: installed. Styles: ${sys.styles.join(', ') || '(unknown)'}. Files: ${sys.files.slice(0, 6).join(', ') || '(unknown)'}`,
        );
      } else {
        const similar = (await listSystemFonts())
          .filter((f) => f.family.toLowerCase().includes(family.trim().toLowerCase()))
          .slice(0, 5)
          .map((f) => f.family);
        lines.push(
          `- System: not installed${similar.length ? ` (similar: ${similar.join(', ')})` : ''}.`,
        );
      }
      if (emb) {
        lines.push(
          emb.source === 'local' || !emb.files?.length
            ? `- Document: registered as a local font (no embedded files).`
            : `- Document: embedded. Files: ${emb.files.join(', ')}; weights: ${(emb.weights ?? []).join(', ') || '(all)'}.`,
        );
      } else {
        lines.push(
          '- Document: not registered. Use add_font to embed (google, file, URL) or register as local.',
        );
      }
      lines.push(`Usage: ${fontFamilyCss(sys?.family ?? emb?.family ?? family)}`);
      return lines.join('\n');
    },
  );

  tool(
    'add_font',
    {
      title: 'Add font to the document',
      description:
        'Registers a font in the document: source "google" (downloads and embeds), "local" (installed), a file/folder path or an http(s) URL. Except for "local", the document must have a path on disk.',
      example: { family: 'Inter', source: 'google', weights: [400, 700] },
      inputSchema: {
        family: z.string().min(1).describe('Family name, e.g. "Inter".'),
        source: z
          .string()
          .describe('"google", "local", a file/folder path or an http(s) URL of the font file.'),
        weights: z
          .array(z.number().int().min(100).max(900))
          .optional()
          .describe('Weights from 100 to 900, e.g. [400, 600, 700] (google default: 400 and 700).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ family, source, weights, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const fam = family.trim();
      const src = source.trim();
      let ref: FontRef;
      const notes: string[] = [];

      if (src.toLowerCase() === 'local') {
        const installed = (await listSystemFonts()).some(
          (f) => f.family.toLowerCase() === fam.toLowerCase(),
        );
        if (!installed)
          notes.push(
            `Warning: "${fam}" was not found among the installed fonts; check with list_fonts.`,
          );
        ref = { family: fam, source: 'local' };
      } else {
        const assets = store.assetsDir(id);
        if (!assets)
          throw new ToolError(
            'The document has no path on disk yet, so there is nowhere to write assets/fonts. Save the document first (create_document or Save As).',
          );
        let files: FontFile[];
        const isGoogle = src.toLowerCase() === 'google';
        if (isGoogle) files = await filesFromGoogle(fam, weights?.length ? weights : [400, 700]);
        else if (/^https?:\/\//i.test(src)) files = await filesFromUrl(src, weights);
        else if (path.isAbsolute(src)) files = await filesFromPath(src, weights);
        else
          throw new ToolError(
            `Invalid source: "${src}". Use "google", "local", an absolute path or an http(s) URL.`,
          );
        files = dedupeFormats(files);
        // Weights requested from a single file (variable font): the document keeps the full list of
        // weights with one file, and the @font-face comes out with the "min max" range.
        const requested = files.map((f) => f.weight).sort((a, b) => a - b);
        files.sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style));
        files = mergeIdenticalFiles(files);
        const slug = uniqueSlug(
          fam,
          doc.fonts
            .filter((f) => f.family.toLowerCase() !== fam.toLowerCase())
            .map((f) => f.family),
        );
        const dir = path.join(assets, 'fonts');
        const names: string[] = [];
        for (const f of files) names.push(`fonts/${await writeFontFile(dir, slug, f)}`);
        ref = {
          family: fam,
          source: 'file',
          files: names,
          weights:
            files.length < requested.length && files.every((f) => f.weightMax !== undefined)
              ? requested
              : files.map((f) => f.weight),
          styles: files.map((f) => f.style),
        };
      }

      // Re-adding the family replaces the entry in place (one undo restores the previous one); the
      // old files remain in assets/fonts.
      const at = doc.fonts.findIndex((f) => f.family.toLowerCase() === fam.toLowerCase());
      const fonts = at < 0 ? [...doc.fonts, ref] : doc.fonts.map((f, i) => (i === at ? ref : f));
      ctx.apply(id, [{ type: 'setFonts', fonts }], 'add_font');
      const reg =
        ref.source === 'local'
          ? 'local font (no files)'
          : ref
              .files!.map((f, i) => {
                const ws = ref.weights!;
                const w =
                  ref.files!.length === ws.length ? String(ws[i]) : `${ws[0]}-${ws[ws.length - 1]}`;
                return `${f} (${w} ${ref.styles![i]})`;
              })
              .join(', ');
      return [
        `Font "${fam}" registered: ${reg}.`,
        ...notes,
        `Usage: ${fontFamilyCss(fam)} (and font-weight with the registered weights), via update_styles.`,
      ].join('\n');
    },
  );
}
