import { documentBaseCss } from '@mockup/core';
import { ALL_PROPS } from './props.js';

/** Computed style read into a property → value table. */
export type StyleRec = Record<string, string>;

export function readStyle(cs: CSSStyleDeclaration): StyleRec {
  const rec: StyleRec = {};
  for (const p of ALL_PROPS) rec[p] = cs.getPropertyValue(p);
  return rec;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Per-tag defaults: a hidden `about:blank` iframe (same origin) with the document base CSS, in
 * which each used tag is created once and read via `getComputedStyle`. This is how the canvas will
 * render a node with no author style (UA + `documentBaseCss`).
 */
export class Defaults {
  private iframe: HTMLIFrameElement | null = null;
  private doc: Document | null = null;
  private cache = new Map<string, StyleRec>();
  /** Computed from the iframe's `body`: base of the inheritance at the root. */
  body: StyleRec = {};

  init(): void {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;visibility:hidden;pointer-events:none';
    // Outside the `body` (it is not part of a `body` capture nor does it affect its flow); the traversal still
    // ignores the element via `isOwn`, because capturing `html` would reach it.
    document.documentElement.appendChild(iframe);
    this.iframe = iframe;
    const doc = iframe.contentDocument;
    if (!doc) throw new Error('Could not create the defaults document (iframe).');
    doc.open();
    doc.write(
      `<!doctype html><html><head><style>${documentBaseCss()}</style></head><body></body></html>`,
    );
    doc.close();
    this.doc = doc;
    this.body = readStyle(doc.defaultView!.getComputedStyle(doc.body));
  }

  /** Default of the tag (`variant`: the `type` of inputs; `href` for links, which get underline and color). */
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

  /** The measurement element belongs to the capturer itself (the traversal ignores it). */
  isOwn(el: Element): boolean {
    return el === this.iframe;
  }

  dispose(): void {
    this.iframe?.remove();
    this.iframe = null;
    this.doc = null;
  }
}
