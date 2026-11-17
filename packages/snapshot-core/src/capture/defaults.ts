import { documentBaseCss } from '@mockup/core';
import { ALL_PROPS } from './props.js';

/** Estilo computado lido numa tabela propriedade → valor. */
export type StyleRec = Record<string, string>;

export function readStyle(cs: CSSStyleDeclaration): StyleRec {
  const rec: StyleRec = {};
  for (const p of ALL_PROPS) rec[p] = cs.getPropertyValue(p);
  return rec;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Padrões por tag: um iframe oculto `about:blank` (mesma origem) com o CSS base do documento, no
 * qual cada tag usada é criada uma vez e lida via `getComputedStyle`. É assim que o canvas vai
 * renderizar um nó sem estilo autoral (UA + `documentBaseCss`).
 */
export class Defaults {
  private iframe: HTMLIFrameElement | null = null;
  private doc: Document | null = null;
  private cache = new Map<string, StyleRec>();
  /** Computado do `body` do iframe: base da herança na raiz. */
  body: StyleRec = {};

  init(): void {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;visibility:hidden;pointer-events:none';
    (document.body ?? document.documentElement).appendChild(iframe);
    this.iframe = iframe;
    const doc = iframe.contentDocument;
    if (!doc) throw new Error('Não foi possível criar o documento de padrões (iframe).');
    doc.open();
    doc.write(
      `<!doctype html><html><head><style>${documentBaseCss()}</style></head><body></body></html>`,
    );
    doc.close();
    this.doc = doc;
    this.body = readStyle(doc.defaultView!.getComputedStyle(doc.body));
  }

  /** Padrão da tag (`variant`: `type` dos inputs; `href` para links, que ganham sublinhado e cor). */
  get(tag: string, variant = ''): StyleRec {
    const key = variant ? `${tag}:${variant}` : tag;
    let rec = this.cache.get(key);
    if (rec) return rec;
    const doc = this.doc!;
    const el =
      tag === 'svg' ? doc.createElementNS(SVG_NS, 'svg') : (doc.createElement(tag) as HTMLElement);
    if (tag === 'input' && variant) el.setAttribute('type', variant);
    if (variant === 'href') el.setAttribute('href', '#');
    doc.body.appendChild(el);
    rec = readStyle(doc.defaultView!.getComputedStyle(el));
    this.cache.set(key, rec);
    return rec;
  }

  dispose(): void {
    this.iframe?.remove();
    this.iframe = null;
    this.doc = null;
  }
}
