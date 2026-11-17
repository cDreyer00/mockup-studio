/**
 * Biblioteca global de assets e CDN local: arquivos endereçados por conteúdo em
 * `<dataDir>/cdn/<hash>.<ext>` (hash = 32 primeiros hex do sha256), com índice `index.json`.
 * O mesmo conteúdo sempre dá o mesmo link, mesmo com o documento fechado ou após reiniciar o daemon.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldText } from '@mockup/core';
import { EMBEDDABLE_MIME, detectImage, writeAsset } from './assets.js';

export interface LibraryAsset {
  hash: string;
  /** Extensão sem ponto (png, jpg, gif, webp, svg, avif, woff2, woff, ttf, otf). */
  ext: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  addedAt: string;
  tags: string[];
  /** Caminho relativo servido pelo daemon: `/cdn/<hash>.<ext>`. */
  url: string;
}

export type AssetKind = 'image' | 'font' | 'other';

export interface DetectedAsset {
  /** Extensão com ponto. */
  ext: string;
  mime: string;
  kind: 'image' | 'font';
  width?: number;
  height?: number;
}

export const CDN_FILE_RE = /^([0-9a-f]{32})\.(png|jpg|jpeg|gif|webp|svg|avif|woff2|woff|ttf|otf)$/;
export const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf']);
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);

/** Hash de conteúdo: 32 primeiros hex do sha256. */
export function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/** Tipo da fonte pela assinatura dos bytes (woff2, woff, ttf, otf). */
function detectFont(b: Buffer): string | null {
  if (b.length < 12) return null;
  const sig = b.toString('latin1', 0, 4);
  if (sig === 'wOF2') return '.woff2';
  if (sig === 'wOFF') return '.woff';
  if (sig === 'OTTO') return '.otf';
  if (b.readUInt32BE(0) === 0x00010000 || sig === 'true') return '.ttf';
  return null;
}

/** Detecta imagem ou fonte pelos bytes. `null` se não for nenhum dos dois. */
export function detectAsset(bytes: Buffer): DetectedAsset | null {
  const img = detectImage(bytes);
  if (img) return { ...img, kind: 'image' };
  const font = detectFont(bytes);
  if (font) return { ext: font, mime: EMBEDDABLE_MIME[font]!, kind: 'font' };
  return null;
}

/** Tipo (imagem/fonte/outro) pela extensão do nome. */
export function kindOfExt(ext: string): AssetKind {
  const e = ext.toLowerCase();
  return IMAGE_EXTS.has(e) ? 'image' : FONT_EXTS.has(e) ? 'font' : 'other';
}

/** Nome seguro (só [a-zA-Z0-9._-], sem ponto inicial, até 76 chars) sem a extensão. */
export function safeStem(raw: string, fallback = 'arquivo'): string {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const ext = path.extname(last);
  let base = last
    .slice(0, last.length - ext.length)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^\.+/, '');
  base = base.slice(0, 76).replace(/[. ]+$/, '');
  if (!base) base = fallback;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(base)) base += '-arquivo';
  return base;
}

type Entry = Omit<LibraryAsset, 'url'>;

interface IndexFile {
  version: 1;
  assets: Record<string, Omit<Entry, 'hash'>>;
}

export class Library {
  readonly dir: string;
  private entries: Map<string, Entry> | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get indexPath(): string {
    return path.join(this.dir, 'index.json');
  }

  private load(): Map<string, Entry> {
    if (this.entries) return this.entries;
    const map = new Map<string, Entry>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as IndexFile;
      for (const [hash, e] of Object.entries(raw.assets ?? {})) {
        if (/^[0-9a-f]{32}$/.test(hash) && e && typeof e.ext === 'string') {
          map.set(hash, { ...e, hash, tags: Array.isArray(e.tags) ? e.tags : [] });
        }
      }
    } catch {
      // sem índice (ou ilegível): começa vazio
    }
    this.entries = map;
    return map;
  }

  /** Grava o índice de forma atômica (arquivo temporário + rename). */
  private save(): void {
    const assets: IndexFile['assets'] = {};
    for (const [hash, e] of this.load()) {
      const { hash: _h, ...rest } = e;
      assets[hash] = rest;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, assets } satisfies IndexFile, null, 2));
    fs.renameSync(tmp, this.indexPath);
  }

  private view(e: Entry): LibraryAsset {
    return { ...e, url: `/cdn/${e.hash}.${e.ext}` };
  }

  /** Caminho do arquivo no disco para `hash` (qualquer extensão registrada), ou null. */
  resolve(hash: string): { file: string; asset: LibraryAsset } | null {
    const e = this.load().get(hash);
    if (!e) return null;
    const file = path.join(this.dir, `${hash}.${e.ext}`);
    return fs.existsSync(file) ? { file, asset: this.view(e) } : null;
  }

  has(hash: string): boolean {
    return this.resolve(hash) !== null;
  }

  get(hash: string): LibraryAsset | null {
    return this.resolve(hash)?.asset ?? null;
  }

  /** Caminho do arquivo servido por `/cdn/<hash>.<ext>` (só se existir e a extensão bater). */
  fileFor(name: string): string | null {
    const m = CDN_FILE_RE.exec(name);
    if (!m) return null;
    const r = this.resolve(m[1]!);
    if (!r) return null;
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    return r.asset.ext === ext ? r.file : null;
  }

  /**
   * Registra bytes (imagem ou fonte). Idempotente: o mesmo conteúdo dá a mesma entrada (o nome da
   * primeira vez é mantido; tags novas são somadas).
   */
  add(
    bytes: Buffer,
    opts: { name?: string; tags?: string[]; info?: DetectedAsset } = {},
  ): LibraryAsset {
    const info = opts.info ?? detectAsset(bytes);
    if (!info) {
      throw new Error(
        'O conteúdo não é uma imagem (PNG, JPEG, GIF, WebP, SVG, AVIF) nem uma fonte (woff2, woff, ttf, otf) reconhecida.',
      );
    }
    const ext = info.ext.slice(1);
    const hash = hashBytes(bytes);
    const map = this.load();
    const file = path.join(this.dir, `${hash}.${ext}`);
    const existing = map.get(hash);
    if (existing && fs.existsSync(file)) {
      const extra = (opts.tags ?? []).filter((t) => t && !existing.tags.includes(t));
      if (extra.length) {
        existing.tags = [...existing.tags, ...extra];
        this.save();
      }
      return this.view(existing);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    const entry: Entry = {
      hash,
      ext,
      name: (opts.name ? path.basename(opts.name) : '') || `${hash}.${ext}`,
      mime: info.mime,
      size: bytes.length,
      ...(info.width ? { width: info.width, height: info.height } : {}),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      tags: [...new Set(opts.tags ?? existing?.tags ?? [])],
    };
    map.set(hash, entry);
    this.save();
    return this.view(entry);
  }

  /** Registra um arquivo do disco (por exemplo, de `assets/` de um documento). */
  async addFile(
    file: string,
    opts: { name?: string; tags?: string[] } = {},
  ): Promise<LibraryAsset> {
    const bytes = await fs.promises.readFile(file);
    return this.add(bytes, { name: path.basename(file), ...opts });
  }

  /** Lista, mais recentes primeiro; `query` filtra por nome ou tag (sem acento, sem caixa). */
  list(query?: string): LibraryAsset[] {
    const terms = foldText(query ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const all = [...this.load().values()]
      .filter((e) => fs.existsSync(path.join(this.dir, `${e.hash}.${e.ext}`)))
      .map((e) => this.view(e));
    const out = terms.length
      ? all.filter((a) => {
          const hay = foldText(`${a.name} ${a.tags.join(' ')} ${a.ext}`);
          return terms.every((t) => hay.includes(t));
        })
      : all;
    return out.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.name.localeCompare(b.name));
  }

  /** Remove da biblioteca (arquivo e índice). Devolve false se não existia. */
  remove(hash: string): boolean {
    const map = this.load();
    const e = map.get(hash);
    if (!e) return false;
    try {
      fs.rmSync(path.join(this.dir, `${hash}.${e.ext}`), { force: true });
    } catch {
      // arquivo em uso: sai só do índice
    }
    map.delete(hash);
    this.save();
    return true;
  }

  /**
   * Copia o asset para a pasta `assets/` de um documento sem sobrescrever (sufixo -1, -2...).
   * Devolve o caminho final relativo a `assets/` (usável como `src`; fontes vão para `fonts/`).
   */
  async importTo(hash: string, assetsDir: string): Promise<string> {
    const r = this.resolve(hash);
    if (!r) throw new Error(`Asset não encontrado na biblioteca: ${hash}`);
    const stem = safeStem(r.asset.name, 'imagem');
    const bytes = await fs.promises.readFile(r.file);
    const isFont = r.asset.mime.startsWith('font/');
    const dir = isFont ? path.join(assetsDir, 'fonts') : assetsDir;
    const file = await writeAsset(dir, `${stem}.${r.asset.ext}`, bytes);
    return isFont ? `fonts/${file}` : file;
  }
}

const libraries = new Map<string, Library>();

/** Pasta do CDN: `<dataDir>/cdn`, ou uma pasta temporária por processo quando não há dataDir. */
export function cdnDirFor(dataDir?: string): string {
  return dataDir
    ? path.join(path.resolve(dataDir), 'cdn')
    : path.join(os.tmpdir(), `mockup-cdn-${process.pid}`);
}

/** Singleton por pasta. */
export function getLibrary(dataDir?: string): Library {
  const dir = cdnDirFor(dataDir);
  let lib = libraries.get(dir);
  if (!lib) {
    lib = new Library(dir);
    libraries.set(dir, lib);
  }
  return lib;
}
