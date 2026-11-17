/**
 * Code export (html, tailwind, react) with direct links to the daemon itself
 * (`http://127.0.0.1:<port>/cdn/<hash>.<ext>` or `/cdn/<hash>.<ext>`): replaces each link with
 * `cdn/<hash>.<ext>` (relative to `assets/`) in a copy of the document and copies the library
 * files to `<output>/assets/cdn/`, so the exported code does not depend on the daemon running.
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
  /** CDN name (`<hash>.<ext>`) → library file. */
  files: Map<string, string>;
}

/** Copy of the document with the `/cdn` links known to the library replaced by `cdn/<name>`. */
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

/** Copies the library files to `<outputDir>/assets/cdn/`; returns the relative paths copied. */
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
      // file disappeared from the library: the link stays as it was in the document
    }
  }
  return copied;
}
