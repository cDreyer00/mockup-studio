/**
 * Pipeline de importação de snapshots: valida o payload, grava imagens e fontes em `assets/` (ou
 * embute como data URL em documento não salvo), converte a raiz em frame e cria tudo numa única
 * chamada `store.applyOps` (uma entrada no histórico). Usado pelas rotas HTTP e pelas ferramentas MCP.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BLOCKED_TAGS,
  FONT_EXTS,
  FontRefSchema,
  NodeSchema,
  TAG_RE,
  attrNameProblem,
  cloneNodeWithNewIds,
  createNodeFromTag,
  newNodeId,
  type Document,
  type FontRef,
  type Node,
  type Op,
  type OpSource,
  type Page,
} from '@mockup/core';
import {
  assetRefId,
  type ImportPlacement,
  type SnapshotAsset,
  type SnapshotFont,
  type SnapshotImportResult,
  type SnapshotPayload,
} from '@mockup/snapshot-core';
import { detectImage, fetchBytes, parseDataUrl, type ImageInfo } from '../assets.js';
import { fontSlug } from '../fonts.js';
import type { DocumentStore } from '../store.js';
import { SnapshotImportError, validateSnapshotPayload } from './validate.js';

/** Limite de um arquivo baixado (imagem ou fonte). */
export const MAX_IMPORT_ASSET_BYTES = 20 * 1024 * 1024;
const ASSET_TIMEOUT_MS = 15_000;
const ASSET_CONCURRENCY = 4;
/** Maior imagem embutida como data URL num estilo `url()` (o canvas não resolve caminhos relativos ali). */
const MAX_CSS_DATA_URL_BYTES = 2 * 1024 * 1024;
const GAP_AFTER_LAST = 80;
const GAP_REFERENCE = 40;

export interface ImportOptions {
  /**
   * Origem do evento no histórico/WS. As ferramentas MCP passam `'mcp'` (o editor mostra o selo
   * "IA" trabalhando); as rotas HTTP passam `'editor'`: quem importa é o usuário (extensão, colar
   * no editor), não um agente, então o editor não deve exibir o selo de IA.
   */
  source: OpSource;
  /** Como o payload foi obtido (padrão `snapshot`; a conversão sem render usa `html`). */
  method?: SnapshotImportResult['method'];
  /** Aviso extra no início da lista (ex.: fidelidade menor na conversão sem render). */
  warnings?: string[];
}

/* ------------------------------ utilidades ------------------------------ */

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const short = (s: string, max = 100): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Nome base seguro (sem extensão) a partir de uma URL ou nome. */
function stemFrom(raw: string, fallback: string): string {
  let last = '';
  try {
    last = path.posix.basename(new URL(raw).pathname);
  } catch {
    last = path.basename(raw);
  }
  try {
    last = decodeURIComponent(last);
  } catch {
    // mantém como veio
  }
  const stem = last
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  return stem || fallback;
}

const sha8 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 8);

const dataUrlOf = (mime: string, bytes: Uint8Array): string =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

/** Grava sem sobrescrever; arquivo de mesmo conteúdo no destino é reaproveitado. Devolve o nome. */
async function writeDedupe(dir: string, name: string, bytes: Buffer): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const finalName = i === 0 ? name : `${base}-${i}${ext}`;
    const file = path.join(dir, finalName);
    try {
      await fs.promises.writeFile(file, bytes, { flag: 'wx' });
      return finalName;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if ((await fs.promises.readFile(file)).equals(bytes)) return finalName;
      } catch {
        // some entre a checagem e a leitura: tenta o próximo nome
      }
    }
  }
  throw new Error(`Não foi possível gravar "${name}" em ${dir}: nomes esgotados.`);
}

/* ------------------------------ download ------------------------------ */

interface Bytes {
  bytes: Buffer;
  /** MIME informado (data URL ou resposta HTTP), minúsculo. */
  mime: string;
}

async function loadBytes(dataUrl: string | undefined, url: string, what: string): Promise<Bytes> {
  if (dataUrl) {
    const d = parseDataUrl(dataUrl);
    if (d && d.bytes.length > 0) {
      if (d.bytes.length > MAX_IMPORT_ASSET_BYTES)
        throw new Error(`${what} passa do limite de 20 MB`);
      return { bytes: d.bytes, mime: d.mime };
    }
  }
  if (url.startsWith('data:')) {
    const d = parseDataUrl(url);
    if (!d || d.bytes.length === 0) throw new Error(`${what}: data URL inválida`);
    if (d.bytes.length > MAX_IMPORT_ASSET_BYTES)
      throw new Error(`${what} passa do limite de 20 MB`);
    return { bytes: d.bytes, mime: d.mime };
  }
  if (!/^https?:\/\//i.test(url)) throw new Error(`${what}: só http(s) e data: podem ser baixados`);
  const r = await fetchBytes(url, {
    maxBytes: MAX_IMPORT_ASSET_BYTES,
    timeoutMs: ASSET_TIMEOUT_MS,
  });
  return { bytes: r.bytes, mime: r.contentType };
}

interface LoadedImage {
  bytes: Buffer;
  info: ImageInfo;
  url: string;
}

/* ------------------------------ imagens ------------------------------ */

class ImageStore {
  private cache = new Map<string, Promise<LoadedImage | null>>();
  private written = new Map<string, string>();
  private readonly assets: Map<string, SnapshotAsset>;

  constructor(
    assets: SnapshotAsset[],
    private readonly assetsDir: string | null,
    private readonly warn: (m: string) => void,
  ) {
    this.assets = new Map(assets.map((a) => [a.id, a]));
  }

  asset(id: string): SnapshotAsset | undefined {
    return this.assets.get(id);
  }

  load(id: string): Promise<LoadedImage | null> {
    let p = this.cache.get(id);
    if (!p) {
      p = this.doLoad(id);
      this.cache.set(id, p);
    }
    return p;
  }

  private async doLoad(id: string): Promise<LoadedImage | null> {
    const a = this.assets.get(id);
    if (!a) {
      this.warn(`Imagem "asset:${id}" não consta na lista de assets do snapshot.`);
      return null;
    }
    if (a.kind !== 'image') {
      this.warn(`O asset ${id} (${short(a.url, 60)}) é uma fonte, não uma imagem.`);
      return null;
    }
    try {
      const { bytes } = await loadBytes(a.dataUrl, a.url, 'a imagem');
      const info = detectImage(bytes);
      if (!info)
        throw new Error(
          'o conteúdo não é uma imagem reconhecida (PNG, JPEG, GIF, WebP, SVG ou AVIF)',
        );
      return { bytes, info, url: a.url };
    } catch (e) {
      this.warn(
        `Imagem não importada (${short(a.url)}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** Grava em `assets/` (documento salvo) e devolve o caminho relativo. */
  async toFile(img: LoadedImage, fallbackStem: string): Promise<string> {
    const hash = sha8(img.bytes);
    const known = this.written.get(`${hash}${img.info.ext}`);
    if (known) return known;
    const name = `${stemFrom(img.url, fallbackStem)}${img.info.ext}`;
    const file = await writeDedupe(this.assetsDir!, name, img.bytes);
    this.written.set(`${hash}${img.info.ext}`, file);
    return file;
  }
}

const CSS_ASSET_URL = /url\(\s*(["']?)asset:([\w-]{1,32})\1\s*\)/g;

function collectAssetRefs(root: Node): { img: Set<string>; css: Set<string> } {
  const img = new Set<string>();
  const css = new Set<string>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const id = n.type === 'image' ? assetRefId(n.src) : null;
    if (id) img.add(id);
    for (const v of Object.values(n.style)) {
      for (const m of v.matchAll(CSS_ASSET_URL)) css.add(m[2]!);
    }
    for (const c of n.children) stack.push(c);
  }
  return { img, css };
}

/** Remove nós/atributos que o `NodeSchema` recusaria (tags bloqueadas, `on*`...), com aviso. */
function sanitizeTree(root: Node, warn: (m: string) => void): void {
  const dropped = new Set<string>();
  const walk = (n: Node): void => {
    n.style = Object.fromEntries(
      Object.entries(n.style ?? {}).filter(([, v]) => typeof v === 'string'),
    );
    n.attrs = Object.fromEntries(
      Object.entries(n.attrs ?? {}).filter(([k, v]) => {
        if (typeof v !== 'string') return false;
        if (attrNameProblem(k)) {
          dropped.add(`atributo ${k}`);
          return false;
        }
        return true;
      }),
    );
    n.children = (n.children ?? []).filter((c) => {
      const tag = typeof c.tag === 'string' ? c.tag.trim().toLowerCase() : '';
      if (!TAG_RE.test(tag) || BLOCKED_TAGS.has(tag)) {
        dropped.add(`tag <${short(tag, 30)}>`);
        return false;
      }
      return true;
    });
    for (const c of n.children) walk(c);
  };
  walk(root);
  if (dropped.size > 0) {
    warn(`Itens removidos por segurança: ${[...dropped].slice(0, 8).join(', ')}.`);
  }
}

/* ------------------------------ fontes ------------------------------ */

const FONT_RANK: Record<string, number> = { woff2: 0, woff: 1, ttf: 2, otf: 2 };
const FONT_MIME_EXT: Record<string, string> = {
  'font/woff2': 'woff2',
  'application/font-woff2': 'woff2',
  'font/woff': 'woff',
  'application/font-woff': 'woff',
  'application/x-font-woff': 'woff',
  'font/ttf': 'ttf',
  'font/sfnt': 'ttf',
  'application/x-font-ttf': 'ttf',
  'application/x-font-truetype': 'ttf',
  'font/otf': 'otf',
  'application/x-font-opentype': 'otf',
  'application/vnd.ms-opentype': 'otf',
};

function fontExtOf(a: SnapshotAsset): string | null {
  let pathname = a.url;
  if (!a.url.startsWith('data:')) {
    try {
      pathname = new URL(a.url).pathname;
    } catch {
      // usa o texto como veio
    }
    const ext = path.posix.extname(pathname).toLowerCase().replace('.', '');
    if (FONT_EXTS.includes(ext)) return ext;
  }
  const mime =
    a.mime?.toLowerCase() ?? (/^data:([^;,]*)/i.exec(a.dataUrl ?? a.url)?.[1] ?? '').toLowerCase();
  return FONT_MIME_EXT[mime] ?? null;
}

interface WeightRange {
  lo: number;
  hi: number;
}

function parseWeight(w: string): WeightRange {
  const t = w.trim().toLowerCase();
  if (t === 'bold') return { lo: 700, hi: 700 };
  const nums =
    t
      .match(/\d+/g)
      ?.map(Number)
      .filter((n) => n >= 1 && n <= 1000) ?? [];
  if (nums.length >= 2)
    return { lo: Math.min(nums[0]!, nums[1]!), hi: Math.max(nums[0]!, nums[1]!) };
  if (nums.length === 1) return { lo: nums[0]!, hi: nums[0]! };
  return { lo: 400, hi: 400 };
}

interface FontEntry {
  file: string;
  lo: number;
  hi: number;
  style: 'normal' | 'italic' | 'oblique';
}

/** Escolhe, por peso/estilo, a declaração mais completa (sem `unicode-range` ou a do latim). */
function pickSlots(fonts: SnapshotFont[]): { slots: SnapshotFont[]; droppedSubsets: number } {
  const groups = new Map<string, SnapshotFont[]>();
  for (const f of fonts) {
    const w = parseWeight(f.weight);
    const key = `${w.lo}-${w.hi}/${f.style.trim().toLowerCase() === 'normal' ? 'normal' : f.style.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const slots: SnapshotFont[] = [];
  let droppedSubsets = 0;
  for (const g of groups.values()) {
    const best =
      g.find((f) => !f.unicodeRange) ??
      g.find((f) => /u\+0000-00ff/i.test(f.unicodeRange ?? '')) ??
      g[0]!;
    slots.push(best);
    droppedSubsets += g.length - 1;
  }
  return { slots, droppedSubsets };
}

// eslint-disable-next-line no-control-regex
const FAMILY_UNSAFE = /[<>{};"'\\`\u0000-\u001f\u007f]/g;
const sanitizeFamily = (f: string): string => f.replace(FAMILY_UNSAFE, '').trim().slice(0, 200);

/** Slug da família; se outra família do documento gera o mesmo slug, acrescenta um sufixo estável. */
function uniqueSlug(family: string, others: string[]): string {
  const slug = fontSlug(family);
  if (!others.some((o) => fontSlug(o) === slug)) return slug;
  return `${slug}-${createHash('sha1').update(family.toLowerCase()).digest('hex').slice(0, 4)}`;
}

const clamp400 = (e: { lo: number; hi: number }): number => Math.min(Math.max(400, e.lo), e.hi);

/**
 * Representação para `fontFaceCss`: com todas as entradas estáticas, `weights[i]` é o peso do
 * `files[i]`; com faixas iguais (fonte variável), `weights` guarda os extremos com tamanho diferente
 * de `files` (o @font-face sai com "min max" em todos os arquivos, como o add_font). Misturas não
 * têm representação exata: as faixas viram o peso 400 (ou o mais próximo dentro da faixa).
 */
function buildRef(family: string, entries: FontEntry[], warn: (m: string) => void): FontRef {
  const ranged = entries.filter((e) => e.lo !== e.hi);
  const sameRange =
    ranged.length === entries.length &&
    entries.every((e) => e.lo === entries[0]!.lo && e.hi === entries[0]!.hi);
  let weights: number[];
  if (ranged.length === 0) weights = entries.map((e) => e.lo);
  else if (sameRange) {
    weights = [entries[0]!.lo, entries[0]!.hi];
    while (weights.length === entries.length) weights.push(entries[0]!.hi);
  } else {
    warn(
      `Fonte "${family}": faixas de peso misturadas com pesos fixos; as faixas foram registradas como um peso só.`,
    );
    weights = entries.map((e) => (e.lo === e.hi ? e.lo : clamp400(e)));
  }
  return {
    family,
    source: 'file',
    files: entries.map((e) => e.file),
    weights,
    styles: entries.map((e) => e.style),
  };
}

interface FontsOutcome {
  fonts: FontRef[] | null;
  families: string[];
}

async function importFonts(
  payload: SnapshotPayload,
  docFonts: FontRef[],
  assetsDir: string | null,
  warn: (m: string) => void,
): Promise<FontsOutcome> {
  const none: FontsOutcome = { fonts: null, families: [] };
  if (payload.fonts.length === 0) return none;
  if (!assetsDir) {
    const names = [...new Set(payload.fonts.map((f) => f.family))];
    warn(
      `Fontes não importadas (${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}): salve o documento para importar as fontes (elas vão para assets/fonts).`,
    );
    return none;
  }
  const assets = new Map(payload.assets.map((a) => [a.id, a]));
  const byFamily = new Map<string, { family: string; list: SnapshotFont[] }>();
  for (const f of payload.fonts) {
    const family = sanitizeFamily(f.family);
    if (!family) continue;
    const g = byFamily.get(family.toLowerCase()) ?? { family, list: [] };
    g.list.push(f);
    byFamily.set(family.toLowerCase(), g);
  }

  interface Job {
    family: string;
    font: SnapshotFont;
    asset: SnapshotAsset;
    ext: string;
  }
  const jobs: Job[] = [];
  for (const g of byFamily.values()) {
    const { slots, droppedSubsets } = pickSlots(g.list);
    if (droppedSubsets > 0)
      warn(
        `Fonte "${g.family}": ${droppedSubsets} subconjunto(s) (unicode-range) ignorado(s); mantido o principal.`,
      );
    for (const font of slots) {
      const candidates = font.assetIds
        .map((id) => assets.get(id))
        .filter((a): a is SnapshotAsset => !!a && a.kind === 'font')
        .map((asset) => ({ asset, ext: fontExtOf(asset) }))
        .filter((c): c is { asset: SnapshotAsset; ext: string } => !!c.ext)
        .sort((a, b) => (FONT_RANK[a.ext] ?? 9) - (FONT_RANK[b.ext] ?? 9));
      const best = candidates[0];
      if (!best) {
        warn(
          `Fonte "${g.family}" ${font.weight} ${font.style}: nenhum arquivo em woff2, woff, ttf ou otf (eot/svg não são suportados).`,
        );
        continue;
      }
      jobs.push({ family: g.family, font, asset: best.asset, ext: best.ext });
    }
  }

  const loaded = await mapLimit(jobs, ASSET_CONCURRENCY, async (j) => {
    try {
      const { bytes } = await loadBytes(j.asset.dataUrl, j.asset.url, 'a fonte');
      if (/^\s*</.test(bytes.subarray(0, 64).toString('latin1')))
        throw new Error('a resposta não é um arquivo de fonte (HTML?)');
      return bytes;
    } catch (e) {
      warn(
        `Fonte "${j.family}" não importada (${short(j.asset.url)}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  });

  const dir = path.join(assetsDir, 'fonts');
  const fresh = new Map<string, { family: string; entries: FontEntry[] }>();
  for (const [i, j] of jobs.entries()) {
    const bytes = loaded[i];
    if (!bytes) continue;
    const key = j.family.toLowerCase();
    const w = parseWeight(j.font.weight);
    const style =
      (['italic', 'oblique'] as const).find((s) => s === j.font.style.trim().toLowerCase()) ??
      'normal';
    const slug = uniqueSlug(
      j.family,
      docFonts.filter((f) => f.family.toLowerCase() !== key).map((f) => f.family),
    );
    const range = w.lo !== w.hi ? `${w.lo}-${w.hi}` : String(w.lo);
    const file = await writeDedupe(dir, `${slug}-${range}-${style}-${sha8(bytes)}.${j.ext}`, bytes);
    const g = fresh.get(key) ?? { family: j.family, entries: [] };
    g.entries.push({ file: `fonts/${file}`, lo: w.lo, hi: w.hi, style });
    fresh.set(key, g);
  }

  const result = [...docFonts];
  const families: string[] = [];
  for (const [key, g] of fresh) {
    const at = result.findIndex((f) => f.family.toLowerCase() === key);
    const entries = g.entries.sort((a, b) => a.lo - b.lo || a.style.localeCompare(b.style));
    let ref: FontRef;
    if (at < 0) {
      ref = buildRef(g.family, entries, warn);
    } else {
      const cur = result[at]!;
      const parallel =
        cur.source === 'file' &&
        !!cur.files?.length &&
        cur.weights?.length === cur.files.length &&
        cur.styles?.length === cur.files.length;
      if (cur.source !== 'file') {
        warn(
          `Fonte "${cur.family}" já existe no documento (${cur.source ?? 'local'}); não foi alterada.`,
        );
        continue;
      }
      if (cur.files?.length && !parallel) {
        warn(`Fonte "${cur.family}" já existe com pesos em faixa; não foi alterada.`);
        continue;
      }
      const files = [...(cur.files ?? [])];
      const weights = [...(cur.weights ?? [])];
      const styles = [...(cur.styles ?? [])];
      let added = 0;
      for (const e of entries) {
        const style = e.style;
        const weight = e.lo === e.hi ? e.lo : clamp400(e);
        if (files.includes(e.file)) continue;
        if (weights.some((w, k) => w === weight && styles[k] === style)) continue;
        files.push(e.file);
        weights.push(weight);
        styles.push(style);
        added++;
      }
      if (added === 0) {
        families.push(cur.family);
        continue;
      }
      ref = { ...cur, files, weights, styles };
    }
    const ok = FontRefSchema.safeParse(ref);
    if (!ok.success) {
      warn(
        `Fonte "${ref.family}" não registrada: ${ok.error.issues[0]?.message ?? 'dados inválidos'}.`,
      );
      continue;
    }
    if (at < 0) result.push(ok.data);
    else result[at] = ok.data;
    families.push(ref.family);
  }
  return { fonts: families.length > 0 ? result : null, families };
}

/* ------------------------------ posicionamento ------------------------------ */

function widthOf(n: Node): number {
  const m = /^(-?\d*\.?\d+)px$/.exec((n.style.width ?? '').trim());
  return m ? parseFloat(m[1]!) : 800;
}

function resolveTarget(
  store: DocumentStore,
  placement: ImportPlacement,
): { docId: string; doc: Document; page: Page } {
  let docId = placement.docId;
  if (docId) {
    if (!store.list().some((d) => d.docId === docId))
      throw new SnapshotImportError(
        404,
        `Documento não encontrado: ${docId}. Use list_documents para ver os abertos.`,
      );
  } else {
    docId = store.activeDocId ?? undefined;
    if (!docId || !store.list().some((d) => d.docId === docId))
      throw new SnapshotImportError(
        409,
        'Nenhum documento aberto. Abra ou crie um documento (open_document / create_document) antes de importar.',
      );
  }
  const doc = store.get(docId);
  const page = placement.pageId ? doc.pages.find((p) => p.id === placement.pageId) : doc.pages[0];
  if (!page)
    throw new SnapshotImportError(
      404,
      `Página não encontrada: ${placement.pageId ?? '(primeira)'}.`,
    );
  return { docId, doc, page };
}

function defaultPosition(page: Page): { x: number; y: number } {
  const first = page.frames[0];
  const last = page.frames[page.frames.length - 1];
  if (!first || !last) return { x: 0, y: 0 };
  return {
    x: Math.round((last.position?.x ?? 0) + widthOf(last) + GAP_AFTER_LAST),
    y: Math.round(first.position?.y ?? 0),
  };
}

const pxText = (n: number): string => `${Math.round(n * 100) / 100}px`;

/* ------------------------------ pipeline ------------------------------ */

/** Ids repetidos no payload (o clone preserva o mapeamento) ganham ids novos. */
function uniqueIds(root: Node): void {
  const seen = new Set<string>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n.id)) n.id = newNodeId(n.type);
    seen.add(n.id);
    stack.push(...n.children);
  }
}

function countNodes(root: Node): number {
  let n = 0;
  const stack: Node[] = [root];
  while (stack.length > 0) {
    n++;
    stack.push(...stack.pop()!.children);
  }
  return n;
}

/** Importa o snapshot no documento. Lança `SnapshotImportError` (400/404/409) em erros de uso. */
export async function importSnapshot(
  store: DocumentStore,
  rawPayload: unknown,
  placement: ImportPlacement = {},
  opts: ImportOptions,
): Promise<SnapshotImportResult> {
  const payload = validateSnapshotPayload(rawPayload);
  const { docId, doc, page } = resolveTarget(store, placement);
  const assetsDir = store.assetsDir(docId);

  const warnings: string[] = [...(opts.warnings ?? [])];
  const seen = new Set(warnings);
  const warn = (m: string): void => {
    if (!seen.has(m)) {
      seen.add(m);
      warnings.push(m);
    }
  };
  for (const w of payload.stats.warnings) warn(w);
  if (payload.stats.truncated)
    warn(
      'A captura foi truncada (limite de nós ou de profundidade): parte do conteúdo ficou de fora.',
    );

  // 1) árvore com ids novos; a raiz vira frame
  let cloned: Node;
  try {
    cloned = cloneNodeWithNewIds(payload.root as unknown as Node).node;
    sanitizeTree(cloned, warn);
    uniqueIds(cloned);
  } catch {
    throw new SnapshotImportError(
      400,
      'Snapshot inválido: árvore de nós malformada (cada nó precisa de id, type, tag, name, style, attrs e children).',
    );
  }
  const refs = collectAssetRefs(cloned);

  // 2) imagens (no máximo 4 downloads em paralelo)
  const images = new ImageStore(payload.assets, assetsDir, warn);
  await mapLimit([...new Set([...refs.img, ...refs.css])], ASSET_CONCURRENCY, (id) =>
    images.load(id),
  );

  const imgSrc = new Map<string, string>();
  for (const id of refs.img) {
    const img = await images.load(id);
    if (!img) continue;
    imgSrc.set(
      id,
      assetsDir ? await images.toFile(img, 'imagem') : dataUrlOf(img.info.mime, img.bytes),
    );
  }
  const cssUrl = new Map<string, string>();
  for (const id of refs.css) {
    const img = await images.load(id);
    if (!img) {
      cssUrl.set(id, 'none');
    } else if (img.bytes.length <= MAX_CSS_DATA_URL_BYTES) {
      cssUrl.set(id, `url("${dataUrlOf(img.info.mime, img.bytes)}")`);
    } else if (/^https?:\/\//i.test(img.url)) {
      const safe = img.url.replace(/["'\\()\s<>]/g, (c) => encodeURIComponent(c));
      cssUrl.set(id, `url("${safe}")`);
      warn(
        `Imagem de fundo grande demais para embutir (${(img.bytes.length / 1048576).toFixed(1)} MB): o estilo aponta para a URL original (${short(img.url, 80)}).`,
      );
    } else {
      cssUrl.set(id, 'none');
      warn('Imagem de fundo grande demais para embutir e sem URL http(s): removida.');
    }
  }
  const usedImages = new Set<string>([
    ...[...refs.img].filter((id) => imgSrc.has(id)),
    ...[...refs.css].filter((id) => cssUrl.get(id) !== 'none'),
  ]);

  const resolveTree = (n: Node): void => {
    if (n.type === 'image') {
      const id = assetRefId(n.src);
      if (id) n.src = imgSrc.get(id) ?? '';
      delete n.attrs.srcset;
      delete n.attrs.sizes;
    }
    for (const [k, v] of Object.entries(n.style)) {
      if (v.includes('asset:'))
        n.style[k] = v.replace(CSS_ASSET_URL, (_m, _q, id: string) => cssUrl.get(id) ?? 'none');
    }
    n.children.forEach(resolveTree);
  };
  resolveTree(cloned);

  // 3) fontes
  const fontsOutcome = await importFonts(payload, doc.fonts, assetsDir, warn);

  // 4) frame
  const pos =
    placement.x !== undefined || placement.y !== undefined
      ? {
          ...defaultPosition(page),
          ...(placement.x !== undefined ? { x: placement.x } : {}),
          ...(placement.y !== undefined ? { y: placement.y } : {}),
        }
      : defaultPosition(page);
  const title = payload.source.title.trim();
  const picked =
    placement.name?.trim() ||
    (payload.source.selector && payload.source.selector !== 'body' ? cloned.name : title) ||
    cloned.name;
  const name = (picked || 'Importado').slice(0, 120);
  const tag = ['html', 'body', 'head'].includes(String(cloned.tag).toLowerCase())
    ? 'div'
    : cloned.tag;
  let frame: Node;
  try {
    frame = NodeSchema.parse({
      ...cloned,
      id: newNodeId('frame'),
      type: 'frame',
      tag,
      name,
      hidden: false,
      locked: false,
      position: { x: Math.round(pos.x), y: Math.round(pos.y) },
      style: {
        ...cloned.style,
        position: 'relative',
        width: pxText(payload.width),
        height: pxText(payload.height),
      },
    });
  } catch (e) {
    const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    const detail = issues
      ? issues
          .slice(0, 3)
          .map((i) => `${i.path.map(String).join('.')}: ${i.message}`)
          .join('; ')
      : e instanceof Error
        ? e.message
        : String(e);
    throw new SnapshotImportError(400, `Snapshot inválido: ${detail}.`);
  }

  // 5) referência
  const ops: Op[] = [{ type: 'createNode', parentId: null, pageId: page.id, node: frame }];
  let referenceId: string | undefined;
  if (payload.reference && placement.reference !== false) {
    const ref = payload.reference;
    try {
      const d = parseDataUrl(ref.dataUrl);
      const info = d ? detectImage(d.bytes) : null;
      if (!d || !info || (info.ext !== '.png' && info.ext !== '.jpg'))
        throw new Error('a captura de referência não é um PNG/JPEG válido');
      if (d.bytes.length > MAX_IMPORT_ASSET_BYTES)
        throw new Error('a captura de referência passa de 20 MB');
      const src = assetsDir
        ? await writeDedupe(assetsDir, `referencia-${fontSlug(name)}${info.ext}`, d.bytes)
        : dataUrlOf(info.mime, d.bytes);
      const refName = `Referência — ${name}`;
      const w = pxText(ref.width);
      const h = pxText(ref.height);
      const imgNode = createNodeFromTag('img', {
        name: 'Referência',
        src,
        attrs: { alt: refName },
        styles: { display: 'block', width: w, height: h },
      });
      const refFrame = createNodeFromTag('div', {
        isRoot: true,
        name: refName,
        position: { x: Math.round(pos.x + payload.width + GAP_REFERENCE), y: Math.round(pos.y) },
        styles: { position: 'relative', width: w, height: h },
        children: [imgNode],
      });
      refFrame.hidden = true;
      ops.push({ type: 'createNode', parentId: null, pageId: page.id, node: refFrame });
      referenceId = refFrame.id;
    } catch (e) {
      warn(`Referência não anexada: ${e instanceof Error ? e.message : String(e)}.`);
    }
  }

  if (fontsOutcome.fonts) ops.push({ type: 'setFonts', fonts: fontsOutcome.fonts });

  // 6) tudo numa única entrada do histórico
  try {
    store.applyOps(docId, ops, { source: opts.source, label: `Importar ${short(name, 40)}` });
  } catch (e) {
    throw new SnapshotImportError(
      400,
      `Não foi possível aplicar a importação: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    docId,
    pageId: page.id,
    frameId: frame.id,
    ...(referenceId ? { referenceId } : {}),
    nodes: countNodes(frame),
    images: usedImages.size,
    fonts: fontsOutcome.families,
    warnings,
    method: opts.method ?? 'snapshot',
  };
}
