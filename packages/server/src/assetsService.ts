/**
 * Serviço de assets de um documento: listagem com hash/uso, link no CDN, remoção, limpeza de não
 * usados e otimização (sharp). Compartilhado pelas rotas HTTP e pelas ferramentas MCP.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  assetPathOf,
  collectAssetRefs,
  rewriteAssetRefsOps,
  walk,
  type AssetRef,
  type Document,
  type Op,
} from '@mockup/core';
import type Sharp from 'sharp';
import { EMBEDDABLE_MIME, safeJoin, writeAsset } from './assets.js';
import {
  getLibrary,
  hashBytes,
  kindOfExt,
  detectAsset,
  type AssetKind,
  type DetectedAsset,
} from './library.js';
import { DEFAULT_PORT } from './paths.js';
import { RouteError } from './routes/shared.js';
import type { DocumentStore } from './store.js';

export interface AssetsServiceCtx {
  store: DocumentStore;
  dataDir?: string;
  getPort?: () => number;
}

export interface AssetInfo {
  /** Relativo a `assets/`, com barras normais. */
  path: string;
  name: string;
  /** Com ponto, minúscula (".png"). */
  ext: string;
  kind: AssetKind;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  mtime: number;
  /** Hash do conteúdo (vazio para arquivos que não são imagem/fonte). */
  hash: string;
  /**
   * Link direto absoluto no CDN local. Vazio para arquivos que não são imagem/fonte e para os ainda
   * não registrados no CDN (a listagem não registra; use o link, `get_asset_url` ou o upload).
   */
  cdnUrl: string;
  uses: number;
  nodeIds: string[];
  refKinds: string[];
}

export interface OptimizeOptions {
  paths?: string[];
  maxWidth?: number;
  format?: 'webp' | 'keep';
  quality?: number;
}

export interface OptimizeResult {
  results: { path: string; newPath: string; before: number; after: number }[];
  skipped: { path: string; reason: string }[];
  /** Quantas referências (nós, estilos, dados, fontes) foram reescritas. */
  rewritten: number;
}

/** Origem (`http://127.0.0.1:<porta>`) usada nos links diretos. */
export function baseUrl(ctx: Pick<AssetsServiceCtx, 'getPort'>): string {
  return `http://127.0.0.1:${ctx.getPort?.() || DEFAULT_PORT}`;
}

export function cdnUrlOf(
  ctx: Pick<AssetsServiceCtx, 'getPort'>,
  hash: string,
  ext: string,
): string {
  return `${baseUrl(ctx)}/cdn/${hash}.${ext.replace(/^\./, '')}`;
}

function requireAssetsDir(ctx: AssetsServiceCtx, docId: string): string | null {
  if (!ctx.store.list().some((d) => d.docId === docId)) {
    throw new RouteError(404, `Documento não encontrado: ${docId}`);
  }
  return ctx.store.assetsDir(docId);
}

const HIDDEN = (name: string): boolean =>
  name.startsWith('.') || name.endsWith('~') || /\.(tmp|part|crdownload)$/i.test(name);

async function walkFiles(root: string, rel = ''): Promise<{ rel: string; abs: string }[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { rel: string; abs: string }[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (HIDDEN(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(root, r)));
    else if (e.isFile()) out.push({ rel: r, abs: path.join(root, r) });
  }
  return out;
}

interface HashEntry {
  mtimeMs: number;
  size: number;
  hash: string;
  info: DetectedAsset | null;
}
/** Cache de hash por caminho (validado por mtime e tamanho), com teto: descarta o menos usado. */
const HASH_CACHE_MAX = 2000;
const hashCache = new Map<string, HashEntry>();

function cachedHash(abs: string): HashEntry | undefined {
  const c = hashCache.get(abs);
  if (c) {
    hashCache.delete(abs);
    hashCache.set(abs, c);
  }
  return c;
}

function rememberHash(abs: string, entry: HashEntry): void {
  hashCache.delete(abs);
  hashCache.set(abs, entry);
  while (hashCache.size > HASH_CACHE_MAX) {
    hashCache.delete(hashCache.keys().next().value!);
  }
}

/** Caminhos de `assets/` usados por `dataSource.path` dos repetidores (não podem ser apagados). */
function dataSourcePaths(doc: Document): Set<string> {
  const out = new Set<string>();
  walk(doc, (n) => {
    const p = assetPathOf(n.dataSource?.path);
    if (p) out.add(p);
  });
  return out;
}

/** Lista recursivamente `assets/` com hash, dimensões, link no CDN e uso no documento. */
export async function listDocAssets(ctx: AssetsServiceCtx, docId: string): Promise<AssetInfo[]> {
  const dir = requireAssetsDir(ctx, docId);
  if (!dir) return [];
  const refs = collectAssetRefs(ctx.store.get(docId));
  const lib = getLibrary(ctx.dataDir);
  const files = await walkFiles(dir);
  const out: AssetInfo[] = [];
  for (const f of files) {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(f.abs);
    } catch {
      continue;
    }
    const ext = path.extname(f.rel).toLowerCase();
    const kind = kindOfExt(ext);
    let hash = '';
    let cdnUrl = '';
    let info: DetectedAsset | null = null;
    if (kind !== 'other') {
      let c = cachedHash(f.abs);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        const bytes = await fs.promises.readFile(f.abs);
        c = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          hash: hashBytes(bytes),
          info: detectAsset(bytes),
        };
        rememberHash(f.abs, c);
      }
      info = c.info;
      if (c.info) {
        hash = c.hash;
        // Só lê: o link aparece se o arquivo já foi registrado no CDN.
        if (lib.has(hash)) cdnUrl = cdnUrlOf(ctx, hash, c.info.ext);
      }
    }
    const ref: AssetRef | undefined = refs.get(f.rel);
    out.push({
      path: f.rel,
      name: path.basename(f.rel),
      ext,
      kind,
      mime: info?.mime ?? EMBEDDABLE_MIME[ext] ?? 'application/octet-stream',
      size: st.size,
      ...(info?.width ? { width: info.width, height: info.height } : {}),
      mtime: Math.round(st.mtimeMs),
      hash,
      cdnUrl,
      uses: ref?.nodeIds.length ?? 0,
      nodeIds: ref?.nodeIds ?? [],
      refKinds: ref?.kinds ?? [],
    });
  }
  return out;
}

function resolveRel(
  ctx: AssetsServiceCtx,
  docId: string,
  rel: string,
): { dir: string; rel: string; abs: string } {
  const dir = requireAssetsDir(ctx, docId);
  if (!dir) throw new RouteError(409, 'O documento ainda não tem caminho em disco; salve-o antes.');
  const clean = assetPathOf(rel) ?? assetPathOf(`assets/${rel}`);
  const abs = clean ? safeJoin(dir, clean) : null;
  if (!clean || !abs) throw new RouteError(400, `Caminho de asset inválido: "${rel}".`);
  return { dir, rel: clean, abs };
}

/** Remove um arquivo de `assets/`; 409 se estiver em uso e sem `force`. */
export async function removeDocAsset(
  ctx: AssetsServiceCtx,
  docId: string,
  rel: string,
  force: boolean,
): Promise<string[]> {
  const r = resolveRel(ctx, docId, rel);
  if (!fs.existsSync(r.abs)) throw new RouteError(404, `Asset não encontrado: ${r.rel}`);
  const ref = collectAssetRefs(ctx.store.get(docId)).get(r.rel);
  if (ref && !force) {
    throw new RouteError(
      409,
      `"${r.rel}" está em uso por ${ref.nodeIds.length} nó(s)${ref.kinds.includes('font') ? ' e pelas fontes do documento' : ''}. Troque as referências ou use force para remover mesmo assim.`,
    );
  }
  await fs.promises.rm(r.abs, { force: true });
  hashCache.delete(r.abs);
  return [r.rel];
}

/** Remove os arquivos de imagem/fonte de `assets/` que nenhum nó, estilo, dado ou fonte referencia. */
export async function removeUnusedAssets(
  ctx: AssetsServiceCtx,
  docId: string,
  dryRun = false,
): Promise<{ removed: string[]; kept: number }> {
  const dir = requireAssetsDir(ctx, docId);
  if (!dir) return { removed: [], kept: 0 };
  const doc = ctx.store.get(docId);
  const refs = collectAssetRefs(doc);
  const keepData = dataSourcePaths(doc);
  const removed: string[] = [];
  let kept = 0;
  for (const f of await walkFiles(dir)) {
    const removable = kindOfExt(path.extname(f.rel)) !== 'other';
    if (!removable || refs.has(f.rel) || keepData.has(f.rel)) {
      kept++;
      continue;
    }
    if (!dryRun) {
      await fs.promises.rm(f.abs, { force: true });
      hashCache.delete(f.abs);
    }
    removed.push(f.rel);
  }
  return { removed, kept };
}

/** Registra o asset no CDN e devolve o link direto. */
export async function linkDocAsset(
  ctx: AssetsServiceCtx,
  docId: string,
  rel: string,
): Promise<{ hash: string; url: string; cdnPath: string }> {
  const r = resolveRel(ctx, docId, rel);
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(r.abs);
  } catch {
    throw new RouteError(404, `Asset não encontrado: ${r.rel}`);
  }
  const info = detectAsset(bytes);
  if (!info) throw new RouteError(400, `"${r.rel}" não é uma imagem nem uma fonte reconhecida.`);
  const a = getLibrary(ctx.dataDir).add(bytes, { name: path.basename(r.rel), info });
  return { hash: a.hash, url: cdnUrlOf(ctx, a.hash, a.ext), cdnPath: a.url };
}

const OPTIMIZABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);

/**
 * Pastas `node_modules` extras onde procurar o sharp quando o import normal falha. No app
 * empacotado o processo principal e o daemon do CLI são bundles sem node_modules; o sharp (nativo)
 * vai em `resources/native/node_modules` (ver `electron-builder.yml`).
 */
function sharpFallbackDirs(): string[] {
  const dirs: string[] = [];
  const env = process.env['MOCKUP_NATIVE_MODULES'];
  if (env) dirs.push(env);
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) dirs.push(path.join(resources, 'native', 'node_modules'));
  // daemon do CLI empacotado: resources/cli/daemon.mjs
  if (process.argv[1]) {
    dirs.push(path.join(path.dirname(process.argv[1]), '..', 'native', 'node_modules'));
  }
  return dirs;
}

/** Carrega o sharp (import normal ou, no app empacotado, de `resources/native/node_modules`). */
export async function loadSharp(): Promise<typeof Sharp> {
  try {
    return (await import('sharp')).default;
  } catch (first) {
    for (const dir of sharpFallbackDirs()) {
      const entry = path.join(dir, 'sharp');
      if (!fs.existsSync(path.join(entry, 'package.json'))) continue;
      return createRequire(import.meta.url)(entry) as typeof Sharp;
    }
    throw first;
  }
}

/**
 * Otimiza imagens de `assets/` com sharp: reduz para `maxWidth` (sem ampliar), converte para WebP
 * (ou mantém o formato) e só adota o resultado se ficar menor. Grava arquivos novos (não apaga os
 * originais) e reescreve as referências numa única chamada de `applyOps` (um undo).
 */
export async function optimizeDocAssets(
  ctx: AssetsServiceCtx,
  docId: string,
  opts: OptimizeOptions,
  applyOps: (ops: Op[]) => void,
): Promise<OptimizeResult> {
  const dir = requireAssetsDir(ctx, docId);
  if (!dir) throw new RouteError(409, 'O documento ainda não tem caminho em disco; salve-o antes.');
  let sharp: typeof Sharp;
  try {
    sharp = await loadSharp();
  } catch (e) {
    throw new RouteError(
      501,
      `Otimização indisponível: o módulo sharp não carregou (${e instanceof Error ? e.message.split('\n')[0] : String(e)}). No app instalado ele vem em resources/native (só Windows x64); reinstale o app. Em desenvolvimento: \`npm install sharp -w @mockup/server\`.`,
    );
  }
  const refs = collectAssetRefs(ctx.store.get(docId));
  const quality = Math.min(100, Math.max(1, Math.round(opts.quality ?? 82)));
  const format = opts.format ?? 'webp';

  const skipped: OptimizeResult['skipped'] = [];
  let targets: string[];
  if (opts.paths?.length) {
    targets = [];
    for (const p of opts.paths) {
      const r = resolveRel(ctx, docId, p);
      if (!fs.existsSync(r.abs)) skipped.push({ path: r.rel, reason: 'arquivo não encontrado' });
      else targets.push(r.rel);
    }
  } else {
    targets = (await walkFiles(dir)).map((f) => f.rel).filter((r) => refs.has(r));
    targets = targets.filter((r) => kindOfExt(path.extname(r)) === 'image');
  }

  const results: OptimizeResult['results'] = [];
  const renamed = new Map<string, string>();
  for (const rel of [...new Set(targets)]) {
    const ext = path.extname(rel).toLowerCase();
    if (!OPTIMIZABLE.has(ext)) {
      skipped.push({
        path: rel,
        reason:
          ext === '.svg'
            ? 'SVG é vetorial'
            : ext === '.gif'
              ? 'GIF (pode ser animado)'
              : 'não é uma imagem otimizável',
      });
      continue;
    }
    const abs = path.join(dir, rel);
    const input = await fs.promises.readFile(abs);
    try {
      const meta = await sharp(input, { animated: true }).metadata();
      if ((meta.pages ?? 1) > 1) {
        skipped.push({ path: rel, reason: 'imagem animada' });
        continue;
      }
      let pipe = sharp(input).rotate();
      if (opts.maxWidth && meta.width && meta.width > opts.maxWidth) {
        pipe = pipe.resize({ width: Math.round(opts.maxWidth), withoutEnlargement: true });
      }
      const outExt = format === 'webp' ? '.webp' : ext === '.jpeg' ? '.jpg' : ext;
      if (outExt === '.webp') pipe = pipe.webp({ quality });
      else if (outExt === '.jpg') pipe = pipe.jpeg({ quality, mozjpeg: true });
      else if (outExt === '.png') pipe = pipe.png({ compressionLevel: 9, effort: 8 });
      else pipe = pipe.avif({ quality });
      const output = await pipe.toBuffer();
      if (output.length >= input.length) {
        skipped.push({
          path: rel,
          reason: `mantido (${input.length} B; o resultado não ficou menor)`,
        });
        continue;
      }
      const relDir = path.posix.dirname(rel);
      const stem = path.posix.basename(rel, path.extname(rel));
      const name =
        outExt === (ext === '.jpeg' ? '.jpg' : ext)
          ? `${stem}-otimizado${outExt}`
          : `${stem}${outExt}`;
      const finalName = await writeAsset(
        path.join(dir, relDir === '.' ? '' : relDir),
        name,
        output,
      );
      const newPath = relDir === '.' ? finalName : `${relDir}/${finalName}`;
      const outInfo = detectAsset(output);
      if (outInfo) getLibrary(ctx.dataDir).add(output, { name: finalName, info: outInfo });
      results.push({ path: rel, newPath, before: input.length, after: output.length });
      renamed.set(rel, newPath);
    } catch (e) {
      skipped.push({
        path: rel,
        reason: `falha ao processar (${e instanceof Error ? e.message : String(e)})`,
      });
    }
  }
  // O processamento com sharp é assíncrono e pode demorar: relê o documento agora para que as ops
  // (setData/setFonts gravam listas inteiras) partam do estado atual e não desfaçam edições feitas
  // enquanto as imagens eram processadas.
  const current = ctx.store.get(docId);
  const currentRefs = collectAssetRefs(current);
  const ops = rewriteAssetRefsOps(current, renamed);
  if (ops.length) applyOps(ops);
  return {
    results,
    skipped,
    rewritten: [...renamed.keys()].filter((r) => currentRefs.has(r)).length,
  };
}
