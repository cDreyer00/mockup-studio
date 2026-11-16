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
  style: 'normal' | 'italic';
}

/** Preferência de formato quando a fonte traz o mesmo peso/estilo em vários: woff2 > woff > ttf/otf. */
const FORMAT_RANK: Record<string, number> = { woff2: 0, woff: 1, ttf: 2, otf: 2 };

/** Um arquivo por peso/estilo, no melhor formato disponível. */
export function dedupeFormats(files: FontFile[]): FontFile[] {
  const best = new Map<string, FontFile>();
  for (const f of files) {
    const key = `${f.weight}/${f.style}`;
    const cur = best.get(key);
    if (!cur || (FORMAT_RANK[f.ext] ?? 9) < (FORMAT_RANK[cur.ext] ?? 9)) best.set(key, f);
  }
  return [...best.values()];
}

/** Slug da família; se outra família do documento gera o mesmo slug, acrescenta um sufixo estável. */
export function uniqueSlug(family: string, otherFamilies: string[]): string {
  const slug = fontSlug(family);
  if (!otherFamilies.some((o) => fontSlug(o) === slug)) return slug;
  return `${slug}-${createHash('sha1').update(family.toLowerCase()).digest('hex').slice(0, 4)}`;
}

/**
 * Grava a fonte como `<slug>-<peso>-<estilo>-<hash8>.<ext>` (hash do conteúdo): o nome muda quando a
 * fonte muda e nunca sobrescreve arquivo existente. Mesmo conteúdo reaproveita o arquivo.
 */
async function writeFontFile(dir: string, slug: string, f: FontFile): Promise<string> {
  const hash = createHash('sha256').update(f.bytes).digest('hex').slice(0, 8);
  const name = `${slug}-${f.weight}-${f.style}-${hash}.${f.ext}`;
  const file = path.join(dir, name);
  try {
    if ((await fs.promises.readFile(file)).equals(f.bytes)) return name;
  } catch {
    // não existe: grava abaixo
  }
  return writeAsset(dir, name, f.bytes);
}

const fontExt = (file: string): string => path.extname(file).toLowerCase().replace('.', '');

async function filesFromPath(source: string, weights?: number[]): Promise<FontFile[]> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(source);
  } catch {
    throw new ToolError(`Caminho não encontrado: ${source}`);
  }
  const list = st.isDirectory()
    ? (await fs.promises.readdir(source))
        .filter((f) => FONT_EXTS.includes(fontExt(f)))
        .sort()
        .map((f) => path.join(source, f))
    : [source];
  if (!list.length)
    throw new ToolError(`Nenhum arquivo de fonte (${FONT_EXTS.join(', ')}) em ${source}.`);
  const out: FontFile[] = [];
  for (const file of list) {
    const ext = fontExt(file);
    if (!FONT_EXTS.includes(ext))
      throw new ToolError(`Extensão não suportada em ${file}; use ${FONT_EXTS.join(', ')}.`);
    const g = guessFontStyle(file);
    const weight = !st.isDirectory() && weights?.length ? weights[0]! : g.weight;
    if (st.isDirectory() && weights?.length && !weights.includes(weight)) continue;
    const s = await fs.promises.stat(file);
    if (s.size > MAX_ASSET_BYTES) throw new ToolError(`${file} passa do limite de 20 MB.`);
    out.push({ bytes: await fs.promises.readFile(file), ext, weight, style: g.style });
  }
  if (!out.length)
    throw new ToolError(
      `Nenhum arquivo de ${source} corresponde aos pesos ${weights?.join(', ')}. Os pesos são deduzidos do nome (Regular, Bold, Light...).`,
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
      `A URL deve apontar para um arquivo de fonte (${FONT_EXTS.join(', ')}); recebido "${pathname}".`,
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
        ? `O Google Fonts não tem a família "${family}" com os pesos ${weights.join(', ')}. Confira o nome (ex.: "Inter", "Playfair Display") e os pesos disponíveis.`
        : msg,
    );
  }
  const faces = parseGoogleCss(css).filter((f) => f.subset === 'latin');
  if (!faces.length)
    throw new ToolError(`O Google Fonts não devolveu o subconjunto latin de "${family}".`);
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
      title: 'Listar fontes',
      description:
        'Lista as fontes disponíveis: embutidas no documento (assets/fonts) e instaladas no sistema. Filtre por nome com query. ' +
        'Para usar uma fonte fora dessas, use add_font.',
      inputSchema: {
        query: z.string().optional().describe('Filtro por nome (contém), ex.: "inter".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Máximo de fontes do sistema (padrão 50).'),
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
      lines.push(`No documento (${docFonts.length}):`);
      for (const f of docFonts) {
        const w = f.weights?.length ? ` pesos ${[...new Set(f.weights)].join(', ')}` : '';
        lines.push(`- ${f.family} [${f.source === 'local' ? 'local' : 'embutida'}]${w}`);
      }
      const sys = (await listSystemFonts()).filter((f) => match(f.family));
      const max = limit ?? 50;
      lines.push(`No sistema (${sys.length}${sys.length > max ? `, mostrando ${max}` : ''}):`);
      for (const f of sys.slice(0, max)) {
        lines.push(
          `- ${f.family}${embeddedNames.has(f.family.toLowerCase()) ? ' [embutida no documento]' : ''}`,
        );
      }
      if (!sys.length)
        lines.push(
          '(nenhuma fonte do sistema encontrada para esse filtro ou listagem indisponível)',
        );
      return lines.join('\n');
    },
  );

  tool(
    'get_font_info',
    {
      title: 'Informações de uma fonte',
      description:
        'Diz se a fonte está instalada no sistema (arquivos e estilos), se está embutida no documento (arquivos e pesos) e como usá-la em font-family.',
      inputSchema: {
        family: z.string().describe('Nome da família, ex.: "Inter".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ family, docId }) => {
      const sys = (await listSystemFonts()).find(
        (f) => f.family.toLowerCase() === family.trim().toLowerCase(),
      );
      const emb = embedded(docId, family);
      const lines = [`Fonte "${family}":`];
      if (sys) {
        lines.push(
          `- Sistema: instalada. Estilos: ${sys.styles.join(', ') || '(desconhecido)'}. Arquivos: ${sys.files.slice(0, 6).join(', ') || '(desconhecido)'}`,
        );
      } else {
        const similar = (await listSystemFonts())
          .filter((f) => f.family.toLowerCase().includes(family.trim().toLowerCase()))
          .slice(0, 5)
          .map((f) => f.family);
        lines.push(
          `- Sistema: não instalada${similar.length ? ` (parecidas: ${similar.join(', ')})` : ''}.`,
        );
      }
      if (emb) {
        lines.push(
          emb.source === 'local' || !emb.files?.length
            ? `- Documento: registrada como fonte local (sem arquivos embutidos).`
            : `- Documento: embutida. Arquivos: ${emb.files.join(', ')}; pesos: ${(emb.weights ?? []).join(', ') || '(todos)'}.`,
        );
      } else {
        lines.push(
          '- Documento: não registrada. Use add_font para embutir (google, arquivo, URL) ou registrar como local.',
        );
      }
      lines.push(`Uso: ${fontFamilyCss(sys?.family ?? emb?.family ?? family)}`);
      return lines.join('\n');
    },
  );

  tool(
    'add_font',
    {
      title: 'Adicionar fonte ao documento',
      description:
        'Registra uma fonte no documento. source: "google" (baixa agora do Google Fonts, subconjunto latin, e embute em assets/fonts), "local" (fonte já instalada; só registra), ' +
        'caminho de arquivo (.woff2/.woff/.ttf/.otf) ou pasta com os arquivos da família, ou URL http(s) de um arquivo de fonte. ' +
        'weights: pesos desejados (padrão 400 e 700 no google). O documento precisa ter caminho (exceto "local"). Nada é carregado de CDN em runtime.',
      inputSchema: {
        family: z.string().min(1).describe('Nome da família, ex.: "Inter".'),
        source: z
          .string()
          .describe(
            '"google", "local", caminho de arquivo/pasta ou URL http(s) do arquivo de fonte.',
          ),
        weights: z
          .array(z.number().int().min(100).max(900))
          .optional()
          .describe('Pesos, ex.: [400, 600, 700].'),
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
            `Atenção: "${fam}" não foi encontrada entre as fontes instaladas; confira com list_fonts.`,
          );
        ref = { family: fam, source: 'local' };
      } else {
        const assets = store.assetsDir(id);
        if (!assets)
          throw new ToolError(
            'O documento ainda não tem caminho em disco, então não há onde gravar assets/fonts. Salve o documento antes (create_document ou Salvar como).',
          );
        let files: FontFile[];
        const isGoogle = src.toLowerCase() === 'google';
        if (isGoogle) files = await filesFromGoogle(fam, weights?.length ? weights : [400, 700]);
        else if (/^https?:\/\//i.test(src)) files = await filesFromUrl(src, weights);
        else if (path.isAbsolute(src)) files = await filesFromPath(src, weights);
        else
          throw new ToolError(
            `source inválido: "${src}". Use "google", "local", um caminho absoluto ou uma URL http(s).`,
          );
        files = dedupeFormats(files);
        files.sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style));
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
          weights: files.map((f) => f.weight),
          styles: files.map((f) => f.style),
        };
      }

      // Re-adicionar a família troca a entrada no lugar (um undo restaura a anterior); os arquivos
      // antigos continuam em assets/fonts.
      const at = doc.fonts.findIndex((f) => f.family.toLowerCase() === fam.toLowerCase());
      const fonts = at < 0 ? [...doc.fonts, ref] : doc.fonts.map((f, i) => (i === at ? ref : f));
      store.applyOps(id, [{ type: 'setFonts', fonts }], {
        source: 'mcp',
        label: 'add_font',
      });
      const reg =
        ref.source === 'local'
          ? 'fonte local (sem arquivos)'
          : ref.files!.map((f, i) => `${f} (${ref.weights![i]} ${ref.styles![i]})`).join(', ');
      return [
        `Fonte "${fam}" registrada: ${reg}.`,
        ...notes,
        `Uso: ${fontFamilyCss(fam)} (e font-weight com os pesos registrados), via update_styles.`,
      ].join('\n');
    },
  );
}
