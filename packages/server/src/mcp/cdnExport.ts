/**
 * Export de código (html, tailwind, react) com links diretos do próprio daemon
 * (`http://127.0.0.1:<porta>/cdn/<hash>.<ext>` ou `/cdn/<hash>.<ext>`): troca cada link por
 * `cdn/<hash>.<ext>` (relativo a `assets/`) numa cópia do documento e copia os arquivos da
 * biblioteca para `<saída>/assets/cdn/`, para o código exportado não depender do daemon rodando.
 */
import fs from 'node:fs';
import path from 'node:path';
import { walk, type Document } from '@mockup/core';
import type { Library } from '../library.js';

const CDN_LINK_RE =
  /^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?\/cdn\/([0-9a-f]{32}\.[a-z0-9]+)(?:[?#].*)?$/i;
const STYLE_CDN_RE =
  /url\(\s*(["']?)(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?\/cdn\/([0-9a-f]{32}\.[a-z0-9]+)(?:[?#][^"')]*)?\1\s*\)/gi;

export interface LocalizedDoc {
  doc: Document;
  /** Nome no CDN (`<hash>.<ext>`) → arquivo da biblioteca. */
  files: Map<string, string>;
}

/** Cópia do documento com os links `/cdn` conhecidos pela biblioteca trocados por `cdn/<nome>`. */
export function localizeCdnLinks(doc: Document, lib: Library): LocalizedDoc {
  const files = new Map<string, string>();
  const known = (name: string): boolean => {
    const key = name.toLowerCase();
    if (files.has(key)) return true;
    const file = lib.fileFor(key);
    if (file) files.set(key, file);
    return !!file;
  };
  const swap = (v: string): string | undefined => {
    const m = CDN_LINK_RE.exec(v.trim());
    return m && known(m[1]!) ? `cdn/${m[1]!.toLowerCase()}` : undefined;
  };
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return swap(v) ?? v;
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    }
    return v;
  };
  const out = structuredClone(doc);
  walk(out, (n) => {
    if (n.src) n.src = swap(n.src) ?? n.src;
    for (const [k, v] of Object.entries(n.style)) {
      n.style[k] = v.replace(STYLE_CDN_RE, (m, q: string, name: string) =>
        known(name) ? `url(${q}assets/cdn/${name.toLowerCase()}${q})` : m,
      );
    }
    if (n.type === 'repeater' && Array.isArray(n.data)) n.data = deep(n.data) as unknown[];
  });
  return { doc: files.size ? out : doc, files };
}

/** Copia os arquivos da biblioteca para `<outputDir>/assets/cdn/`; devolve os relativos copiados. */
export async function copyCdnFiles(
  files: Map<string, string>,
  outputDir: string,
): Promise<string[]> {
  const copied: string[] = [];
  const dir = path.join(outputDir, 'assets', 'cdn');
  for (const [name, file] of files) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(file, path.join(dir, name));
      copied.push(`cdn/${name}`);
    } catch {
      // arquivo sumiu da biblioteca: o link fica como estava no documento
    }
  }
  return copied;
}
