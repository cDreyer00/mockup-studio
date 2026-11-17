import { DomUtils, parseDocument as parseXml } from 'htmlparser2';
import { resolveVars } from '../computed.js';
import { findNode } from '../document.js';
import { fontFaceCss } from '../fonts.js';
import type { LayoutNode, LayoutRect } from '../layout.js';
import { effectFallbackCss } from '../effects/catalog.js';
import { sanitizeSvg, scopeSvgIds } from '../svg.js';
import type { Document, FontRef } from '../types.js';
import { EMBED_LABELS } from './media.js';
import {
  BASE_CSS,
  cleanTokens,
  escapeHtmlAttr,
  escapeHtmlText,
  renderHtmlTree,
  resolveRoots,
} from './common.js';

export interface SvgExportOptions {
  nodeId: string;
  /**
   * Geometria medida pela página de render (`measure(nodeId)`). Sem ela, o SVG cai para um
   * `<foreignObject>` com o HTML exportado, do tamanho declarado no estilo do nó.
   */
  layout?: LayoutNode;
  /** Resolve o `src` de imagens (relativo a `assets/`) para data URL; `undefined` mantém o src. */
  resolveImage?: (src: string) => string | undefined;
}

/* ====================================================================== */
/* Utilitários                                                             */
/* ====================================================================== */

const num = (n: number): string => String(Math.round(n * 100) / 100);

const escXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** `12px` → 12; `0` → 0; outro → `NaN`. */
function px(v: string | undefined): number {
  if (v === undefined) return NaN;
  const m = /^(-?\d*\.?\d+)(px)?$/.exec(v.trim());
  return m ? parseFloat(m[1]) : NaN;
}

function splitTop(value: string, sep: 'space' | 'comma'): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (sep === 'comma' ? ch === ',' : /\s/.test(ch))) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

interface Paint {
  color: string;
  opacity: number;
}

/** Cor CSS → cor SVG + opacidade (rgba vira `rgb()` + opacity). `null` se transparente/inválida. */
function parsePaint(value: string | undefined): Paint | null {
  if (!value) return null;
  const v = value.trim();
  const lower = v.toLowerCase();
  if (lower === 'transparent' || lower === 'none' || lower === '') return null;
  const rgb =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(v);
  if (rgb) {
    let a = rgb[4] === undefined ? 1 : parseFloat(rgb[4]);
    if (rgb[5]) a /= 100;
    if (a <= 0) return null;
    return { color: `rgb(${rgb[1]},${rgb[2]},${rgb[3]})`, opacity: Math.min(1, a) };
  }
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const a = parseInt(h.slice(6, 8), 16) / 255;
    if (a <= 0) return null;
    return { color: `#${h.slice(0, 6)}`, opacity: a };
  }
  if (/var\(/i.test(v)) return null;
  return { color: v, opacity: 1 };
}

const paintAttrs = (kind: 'fill' | 'stroke', p: Paint): string =>
  ` ${kind}="${escXml(p.color)}"` + (p.opacity < 1 ? ` ${kind}-opacity="${num(p.opacity)}"` : '');

/* ====================================================================== */
/* Formas                                                                  */
/* ====================================================================== */

type Radii = [number, number, number, number]; // tl, tr, br, bl

function parseRadii(style: LayoutNode['style'], w: number, h: number): Radii {
  const keys = [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ] as const;
  const r = keys.map((k) => {
    const first = (style[k] ?? '0').trim().split(/\s+/)[0];
    const pct = /^(\d*\.?\d+)%$/.exec(first);
    if (pct) return (parseFloat(pct[1]) / 100) * Math.min(w, h);
    const n = px(first);
    return Number.isNaN(n) ? 0 : Math.max(0, n);
  }) as Radii;
  // CSS: se a soma dos raios de um lado passa do comprimento, todos são reduzidos pelo mesmo fator
  const f = Math.min(
    1,
    r[0] + r[1] > 0 ? w / (r[0] + r[1]) : 1,
    r[3] + r[2] > 0 ? w / (r[3] + r[2]) : 1,
    r[0] + r[3] > 0 ? h / (r[0] + r[3]) : 1,
    r[1] + r[2] > 0 ? h / (r[1] + r[2]) : 1,
  );
  return f < 1 ? (r.map((v) => v * f) as Radii) : r;
}

function roundedPath(x: number, y: number, w: number, h: number, r: Radii): string {
  const [tl, tr, br, bl] = r;
  const arc = (rad: number, ex: number, ey: number): string =>
    rad > 0 ? ` A${num(rad)},${num(rad)} 0 0 1 ${num(ex)},${num(ey)}` : '';
  return (
    `M${num(x + tl)},${num(y)} H${num(x + w - tr)}${arc(tr, x + w, y + tr)} ` +
    `V${num(y + h - br)}${arc(br, x + w - br, y + h)} H${num(x + bl)}${arc(bl, x, y + h - bl)} ` +
    `V${num(y + tl)}${arc(tl, x + tl, y)} Z`
  );
}

/** `<rect>` (raios iguais) ou `<path>` (raios diferentes) com os atributos extras. */
function shape(rect: LayoutRect, r: Radii, extra: string): string {
  const { x, y, width: w, height: h } = rect;
  if (r.some((v) => v !== r[0])) {
    return `<path d="${roundedPath(x, y, w, h, r)}"${extra}/>`;
  }
  const rx = r[0] > 0 ? ` rx="${num(r[0])}"` : '';
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${rx}${extra}/>`;
}

/** Raios de um retângulo recuado de `d` em cada lado. */
const inset = (r: Radii, d: number): Radii => r.map((v) => Math.max(0, v - d)) as Radii;

/* ====================================================================== */
/* Gradientes e sombras                                                    */
/* ====================================================================== */

const DIRECTIONS: Record<string, number> = {
  'to top': 0,
  'to top right': 45,
  'to right top': 45,
  'to right': 90,
  'to bottom right': 135,
  'to right bottom': 135,
  'to bottom': 180,
  'to bottom left': 225,
  'to left bottom': 225,
  'to left': 270,
  'to top left': 315,
  'to left top': 315,
};

interface Stop {
  paint: Paint | null;
  color: string;
  offset: number;
}

/** `linear-gradient(...)` → `<linearGradient>` em coordenadas do usuário; `null` se não suportado. */
function linearGradient(layer: string, id: string, rect: LayoutRect): string | null {
  const m = /^(repeating-)?linear-gradient\(([\s\S]*)\)$/i.exec(layer.trim());
  if (!m || m[1]) return null;
  const args = splitTop(m[2], 'comma');
  if (args.length < 2) return null;
  let angle = 180;
  const first = args[0].toLowerCase().replace(/\s+/g, ' ');
  const deg = /^(-?\d*\.?\d+)(deg|turn|rad)$/.exec(first);
  if (deg) {
    const n = parseFloat(deg[1]);
    angle = deg[2] === 'turn' ? n * 360 : deg[2] === 'rad' ? (n * 180) / Math.PI : n;
    args.shift();
  } else if (first.startsWith('to ')) {
    if (!(first in DIRECTIONS)) return null;
    angle = DIRECTIONS[first];
    args.shift();
  }
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const len = Math.abs(rect.width * dx) + Math.abs(rect.height * dy);
  if (len === 0) return null;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  const raw: { color: string; pos: number | null }[] = [];
  for (const arg of args) {
    const toks = splitTop(arg, 'space');
    const positions: number[] = [];
    while (toks.length > 1 && /^-?\d*\.?\d+(%|px)$/.test(toks[toks.length - 1])) {
      const t = toks.pop() as string;
      positions.unshift(t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t) / len);
    }
    if (positions.length === 0) raw.push({ color: toks.join(' '), pos: null });
    else for (const p of positions) raw.push({ color: toks.join(' '), pos: p });
  }
  if (raw.length < 2) return null;
  if (raw[0].pos === null) raw[0].pos = 0;
  if (raw[raw.length - 1].pos === null) raw[raw.length - 1].pos = 1;
  for (let i = 1; i < raw.length; i++) {
    const cur = raw[i].pos;
    const prev = raw[i - 1].pos as number;
    if (cur !== null) raw[i].pos = Math.max(cur, prev);
  }
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i].pos !== null) continue;
    let j = i;
    while (raw[j].pos === null) j++;
    const a = raw[i - 1].pos as number;
    const b = raw[j].pos as number;
    for (let k = i; k < j; k++) raw[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  const stops: Stop[] = raw.map((s) => ({
    paint: parsePaint(s.color),
    color: s.color,
    offset: Math.min(1, Math.max(0, s.pos as number)),
  }));
  const x1 = cx - (dx * len) / 2;
  const y1 = cy - (dy * len) / 2;
  const x2 = cx + (dx * len) / 2;
  const y2 = cy + (dy * len) / 2;
  const body = stops
    .map((s) => {
      const p = s.paint ?? { color: 'rgb(0,0,0)', opacity: 0 };
      const op = p.opacity < 1 ? ` stop-opacity="${num(p.opacity)}"` : '';
      return `<stop offset="${num(s.offset)}" stop-color="${escXml(p.color)}"${op}/>`;
    })
    .join('');
  return (
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="${num(y1)}" ` +
    `x2="${num(x2)}" y2="${num(y2)}">${body}</linearGradient>`
  );
}

interface Shadow {
  dx: number;
  dy: number;
  blur: number;
  paint: Paint;
}

/** Primeira sombra externa de `box-shadow` (inset é ignorada). */
function firstOuterShadow(value: string | undefined): Shadow | null {
  if (!value || value.trim() === 'none') return null;
  for (const item of splitTop(value, 'comma')) {
    const toks = splitTop(item, 'space');
    if (toks.some((t) => t.toLowerCase() === 'inset')) continue;
    const lengths: number[] = [];
    let paint: Paint | null = null;
    for (const t of toks) {
      const n = px(t);
      if (!Number.isNaN(n)) lengths.push(n);
      else paint = parsePaint(t) ?? paint;
    }
    if (lengths.length < 2) continue;
    return {
      dx: lengths[0],
      dy: lengths[1],
      blur: Math.max(0, lengths[2] ?? 0),
      paint: paint ?? { color: 'rgb(0,0,0)', opacity: 1 },
    };
  }
  return null;
}

/* ====================================================================== */
/* Renderização com layout medido                                          */
/* ====================================================================== */

const FIT: Record<string, string> = {
  cover: 'xMidYMid slice',
  contain: 'xMidYMid meet',
  fill: 'none',
  'scale-down': 'xMidYMid meet',
  none: 'xMidYMid meet',
};

function applyTransform(text: string, transform: string | undefined): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/(^|\s)(\S)/gu, (_, s: string, c: string) => s + c.toUpperCase());
    default:
      return text;
  }
}

function fontsWithResolvableFiles(
  doc: Document,
  resolve: (src: string) => string | undefined,
): FontRef[] {
  const out: FontRef[] = [];
  for (const f of doc.fonts) {
    if (f.source === 'local' || !f.files || f.files.length === 0) continue;
    const keep = f.files.map((file) => resolve(file) !== undefined);
    if (!keep.some(Boolean)) continue;
    const pick = <T>(arr: T[] | undefined): T[] | undefined =>
      arr && arr.length === f.files!.length ? arr.filter((_, i) => keep[i]) : arr;
    out.push({
      ...f,
      files: f.files.filter((_, i) => keep[i]),
      weights: pick(f.weights),
      styles: pick(f.styles),
    });
  }
  return out;
}

function layoutSvg(doc: Document, layout: LayoutNode, options: SvgExportOptions): string {
  const ox = layout.x;
  const oy = layout.y;
  const width = layout.width;
  const height = layout.height;
  const tokens = cleanTokens(doc.tokens);
  const defs: string[] = [];
  let seq = 0;
  const nextId = (p: string): string => `${p}${++seq}`;

  const draw = (n: LayoutNode): string[] => {
    const st: LayoutNode['style'] = {};
    for (const [k, v] of Object.entries(n.style)) {
      if (v !== undefined) st[k] = resolveVars(v, tokens);
    }
    if (st.display === 'none') return [];
    const opacity = st.opacity === undefined ? 1 : parseFloat(st.opacity);
    if (opacity === 0) return [];

    const rect: LayoutRect = { x: n.x - ox, y: n.y - oy, width: n.width, height: n.height };
    const radii = parseRadii(st, rect.width, rect.height);
    const hasBox = rect.width > 0 && rect.height > 0;
    const visible = st.visibility !== 'hidden' && st.visibility !== 'collapse';
    const out: string[] = [];

    if (visible && hasBox) {
      // fundo (+ sombra)
      const bg = parsePaint(st['background-color']);
      const shadow = firstOuterShadow(st['box-shadow']);
      if (bg) {
        let filterAttr = '';
        if (shadow) {
          const id = nextId('shadow');
          defs.push(
            `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">` +
              `<feDropShadow dx="${num(shadow.dx)}" dy="${num(shadow.dy)}" stdDeviation="${num(shadow.blur / 2)}" ` +
              `flood-color="${escXml(shadow.paint.color)}" flood-opacity="${num(shadow.paint.opacity)}"/></filter>`,
          );
          filterAttr = ` filter="url(#${id})"`;
        }
        out.push(shape(rect, radii, paintAttrs('fill', bg) + filterAttr));
      }
      // gradientes (a primeira camada do CSS é a de cima: desenha de trás para frente)
      const image = st['background-image'];
      if (image && image !== 'none') {
        for (const layer of splitTop(image, 'comma').reverse()) {
          const id = nextId('grad');
          const g = linearGradient(layer, id, rect);
          if (!g) continue;
          defs.push(g);
          out.push(shape(rect, radii, ` fill="url(#${id})"`));
        }
      }
      out.push(...borders(st, rect, radii));
    }

    if (visible && hasBox) out.push(...content(n, st, rect, radii));

    const kids = n.children.flatMap(draw);
    const clips = ['hidden', 'clip', 'auto', 'scroll'].includes(st.overflow ?? '') && hasBox;
    if (kids.length > 0) {
      if (clips) {
        const id = nextId('clip');
        defs.push(`<clipPath id="${id}">${shape(rect, radii, '')}</clipPath>`);
        out.push(`<g clip-path="url(#${id})">`, ...kids, '</g>');
      } else out.push(...kids);
    }
    if (out.length === 0) return [];
    if (opacity < 1) return [`<g opacity="${num(opacity)}">`, ...out, '</g>'];
    return out;
  };

  const borders = (st: LayoutNode['style'], rect: LayoutRect, radii: Radii): string[] => {
    const sides = (['top', 'right', 'bottom', 'left'] as const).map((s) => {
      const w = px(st[`border-${s}-width`]);
      const style = st[`border-${s}-style`] ?? 'solid';
      const paint = parsePaint(st[`border-${s}-color`]);
      const ok = !Number.isNaN(w) && w > 0 && !['none', 'hidden'].includes(style) && paint;
      return { w: ok ? w : 0, style, paint: ok ? paint : null };
    });
    if (sides.every((s) => s.w === 0)) return [];
    const [t, r, b, l] = sides;
    const uniform = sides.every(
      (s) =>
        s.w === t.w &&
        s.style === t.style &&
        s.paint &&
        t.paint &&
        s.paint.color === t.paint.color &&
        s.paint.opacity === t.paint.opacity,
    );
    if (uniform && t.paint) {
      const d = t.w / 2;
      const inner: LayoutRect = {
        x: rect.x + d,
        y: rect.y + d,
        width: Math.max(0, rect.width - t.w),
        height: Math.max(0, rect.height - t.w),
      };
      let dash = '';
      if (t.style === 'dashed') dash = ` stroke-dasharray="${num(t.w * 3)} ${num(t.w * 3)}"`;
      else if (t.style === 'dotted') {
        dash = ` stroke-dasharray="0 ${num(t.w * 2)}" stroke-linecap="round"`;
      }
      return [
        shape(
          inner,
          inset(radii, d),
          ` fill="none"${paintAttrs('stroke', t.paint)} stroke-width="${num(t.w)}"${dash}`,
        ),
      ];
    }
    const strip = (x: number, y: number, w: number, h: number, p: Paint | null): string =>
      p && w > 0 && h > 0
        ? shape({ x, y, width: w, height: h }, [0, 0, 0, 0], paintAttrs('fill', p))
        : '';
    return [
      strip(rect.x, rect.y, rect.width, t.w, t.paint),
      strip(rect.x, rect.y + rect.height - b.w, rect.width, b.w, b.paint),
      strip(rect.x, rect.y + t.w, l.w, rect.height - t.w - b.w, l.paint),
      strip(rect.x + rect.width - r.w, rect.y + t.w, r.w, rect.height - t.w - b.w, r.paint),
    ].filter(Boolean);
  };

  const content = (
    n: LayoutNode,
    st: LayoutNode['style'],
    rect: LayoutRect,
    radii: Radii,
  ): string[] => {
    const out: string[] = [];

    if (n.type === 'image' && n.src) {
      const href = options.resolveImage?.(n.src) ?? n.src;
      const par = FIT[st['object-fit'] ?? 'fill'] ?? 'none';
      let clip = '';
      if (radii.some((v) => v > 0)) {
        const id = nextId('clip');
        defs.push(`<clipPath id="${id}">${shape(rect, radii, '')}</clipPath>`);
        clip = ` clip-path="url(#${id})"`;
      }
      out.push(
        `<image x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" ` +
          `href="${escXml(href)}" preserveAspectRatio="${par}"${clip}/>`,
      );
    }

    if (n.type === 'effect' || n.type === 'video' || n.type === 'embed') {
      out.push(...mediaShapes(n, rect, radii));
    }

    if (n.type === 'svg') {
      const markup = sanitizeSvg(findNode(doc, n.id)?.node.svg ?? '');
      if (markup) out.push(nestedSvg(scopeSvgIds(markup, n.id), rect, st.color));
    }

    for (const line of n.lines ?? []) {
      const fill = parsePaint(st.color) ?? { color: '#000', opacity: 1 };
      const size = px(st['font-size']);
      const spacing = px(st['letter-spacing']);
      const deco = (st['text-decoration-line'] ?? '').split(/\s+/).filter((d) => d && d !== 'none');
      const attrs = [
        `x="${num(line.x - ox)}"`,
        `y="${num(line.y - oy + line.baseline)}"`,
        st['font-family'] ? `font-family="${escXml(st['font-family'])}"` : '',
        Number.isNaN(size) ? '' : `font-size="${num(size)}"`,
        st['font-weight'] && st['font-weight'] !== '400' && st['font-weight'] !== 'normal'
          ? `font-weight="${escXml(st['font-weight'])}"`
          : '',
        st['font-style'] && st['font-style'] !== 'normal'
          ? `font-style="${escXml(st['font-style'])}"`
          : '',
        Number.isNaN(spacing) || spacing === 0 ? '' : `letter-spacing="${num(spacing)}"`,
        deco.length > 0 ? `text-decoration="${escXml(deco.join(' '))}"` : '',
        paintAttrs('fill', fill).trim(),
      ].filter(Boolean);
      out.push(
        `<text ${attrs.join(' ')}>${escapeHtmlText(applyTransform(line.text, st['text-transform']))}</text>`,
      );
    }
    return out;
  };

  /** Efeito: gradiente/cor de fallback; vídeo: poster ou retângulo escuro; embed: placeholder com o provedor. */
  const mediaShapes = (n: LayoutNode, rect: LayoutRect, radii: Radii): string[] => {
    const node = findNode(doc, n.id)?.node;
    if (!node) return [];
    if (n.type === 'effect' && node.effect) {
      const css = effectFallbackCss(node.effect);
      const value = css['background-image'] ?? css.background ?? css['background-color'] ?? '';
      const id = nextId('grad');
      const g = linearGradient(value, id, rect);
      if (g) {
        defs.push(g);
        return [shape(rect, radii, ` fill="url(#${id})"`)];
      }
      const color = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i.exec(value)?.[0];
      const paint = parsePaint(value) ?? parsePaint(color) ?? { color: '#1e1b4b', opacity: 1 };
      return [shape(rect, radii, paintAttrs('fill', paint))];
    }
    if (n.type === 'video') {
      const poster = node.video?.poster;
      if (!poster) return [shape(rect, radii, ' fill="#111111"')];
      const href = options.resolveImage?.(poster) ?? poster;
      const id = nextId('clip');
      defs.push(`<clipPath id="${id}">${shape(rect, radii, '')}</clipPath>`);
      return [
        `<image x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" ` +
          `href="${escXml(href)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`,
      ];
    }
    if (n.type === 'embed' && node.embed) {
      const label = EMBED_LABELS[node.embed.provider];
      return [
        shape(rect, radii, ' fill="#1f2937"'),
        `<text x="${num(rect.x + rect.width / 2)}" y="${num(rect.y + rect.height / 2)}" text-anchor="middle" ` +
          `dominant-baseline="middle" font-family="sans-serif" font-size="14" fill="#9ca3af">${escXml(label)}</text>`,
      ];
    }
    return [];
  };

  const nestedSvg = (markup: string, rect: LayoutRect, color: string | undefined): string => {
    const dom = parseXml(markup, { xmlMode: true });
    const root = DomUtils.findOne((e) => e.name.toLowerCase() === 'svg', dom.children, true);
    if (!root) return '';
    const a = root.attribs;
    if (!a.viewBox) {
      const w = px(a.width);
      const h = px(a.height);
      a.viewBox = `0 0 ${num(Number.isNaN(w) ? rect.width : w)} ${num(Number.isNaN(h) ? rect.height : h)}`;
    }
    delete a.xmlns;
    delete a.class;
    delete a.style;
    a.x = num(rect.x);
    a.y = num(rect.y);
    a.width = num(rect.width);
    a.height = num(rect.height);
    const paint = parsePaint(color);
    if (paint) a.color = paint.color;
    return DomUtils.getOuterHTML(root, { xmlMode: true });
  };

  const body = draw(layout);
  const fontCss = options.resolveImage
    ? fontFaceCss(
        { fonts: fontsWithResolvableFiles(doc, options.resolveImage) },
        (f) => options.resolveImage?.(f) ?? f,
        'swap',
      )
    : '';
  if (fontCss)
    defs.unshift(
      `<style>${fontCss.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</style>`,
    );

  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`;
  return [
    head,
    ...(defs.length > 0 ? ['<defs>', ...defs, '</defs>'] : []),
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

/* ====================================================================== */
/* Fallback: <foreignObject> com o HTML exportado                          */
/* ====================================================================== */

function fallbackSvg(doc: Document, options: SvgExportOptions): string {
  const [root] = resolveRoots(doc, { nodeIds: [options.nodeId] }, { keepHeight: true });
  const w = px(root.style.width);
  const h = px(root.style.height);
  const width = Number.isNaN(w) ? 100 : w;
  const height = Number.isNaN(h) ? 100 : h;

  const markup = renderHtmlTree([root], {
    xhtml: true,
    mediaMode: 'static',
    depth: 3,
    resolveSrc: (src) => options.resolveImage?.(src),
    styleOf: (node) =>
      Object.keys(node.style).length === 0
        ? {}
        : {
            style: Object.entries(node.style)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; '),
          },
  });
  const tokenStyle = Object.entries(cleanTokens(doc.tokens))
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
  const faces = fontFaceCss(doc, (f) => options.resolveImage?.(f) ?? `assets/${f}`, 'swap');
  const css = `${BASE_CSS}${faces ? '\n' + faces : ''}`;
  const wrapper = `<div xmlns="http://www.w3.org/1999/xhtml"${tokenStyle ? ` style="${escapeHtmlAttr(tokenStyle)}"` : ''}>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`,
    `  <foreignObject x="0" y="0" width="${num(width)}" height="${num(height)}">`,
    `    ${wrapper}`,
    `      <style>${escapeHtmlText(css)}</style>`,
    markup,
    '    </div>',
    '  </foreignObject>',
    '</svg>',
    '',
  ].join('\n');
}

/** SVG standalone do nó (rects com raio, borda e sombra; textos posicionados; imagens embutidas). */
export function exportSvg(doc: Document, options: SvgExportOptions): string {
  if (!findNode(doc, options.nodeId)) throw new Error(`Nó "${options.nodeId}" não encontrado`);
  return options.layout ? layoutSvg(doc, options.layout, options) : fallbackSvg(doc, options);
}
