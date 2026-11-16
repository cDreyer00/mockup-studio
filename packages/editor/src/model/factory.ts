/** Fábricas dos nós criados pelas ferramentas do editor (ids gerados pelo core). */
import { createNodeFromTag } from '@mockup/core';
import type { Node } from '@mockup/core';

export const DEFAULT_FRAME = { w: 1440, h: 900 };
export const DEFAULT_RECT = { w: 120, h: 120 };
export const DEFAULT_IMAGE = { w: 240, h: 160 };

const px = (n: number): string => `${Math.round(n)}px`;

let frameCounter = 0;

/** Frame raiz (artboard) posicionado no canvas. */
export function makeFrame(
  x: number,
  y: number,
  w = DEFAULT_FRAME.w,
  h = DEFAULT_FRAME.h,
  name?: string,
): Node {
  return createNodeFromTag('div', {
    isRoot: true,
    name: name ?? `Frame ${++frameCounter}`,
    styles: {
      width: px(w),
      height: px(h),
      background: '#ffffff',
      position: 'relative',
      overflow: 'hidden',
    },
    position: { x: Math.round(x), y: Math.round(y) },
  });
}

/**
 * Container (Retângulo). `absolute` com x/y quando desenhado livremente num pai não-flex;
 * em pai flex entra no fluxo (sem posição).
 */
export function makeContainer(
  opts: { w?: number; h?: number; x?: number; y?: number; absolute?: boolean } = {},
): Node {
  const styles: Record<string, string> = {
    width: px(opts.w ?? DEFAULT_RECT.w),
    height: px(opts.h ?? DEFAULT_RECT.h),
    background: '#d9d9de',
  };
  if (opts.absolute) {
    styles.position = 'absolute';
    styles.left = px(opts.x ?? 0);
    styles.top = px(opts.y ?? 0);
  }
  return createNodeFromTag('div', { name: 'Container', styles });
}

export function makeText(
  opts: { text?: string; x?: number; y?: number; absolute?: boolean } = {},
): Node {
  const styles: Record<string, string> = {
    'font-size': '16px',
    'line-height': '1.4',
    color: '#111111',
  };
  if (opts.absolute) {
    styles.position = 'absolute';
    styles.left = px(opts.x ?? 0);
    styles.top = px(opts.y ?? 0);
  }
  return createNodeFromTag('p', { name: 'Texto', text: opts.text ?? 'Texto', styles });
}

export function makeImage(
  src: string,
  opts: { w?: number; h?: number; x?: number; y?: number; absolute?: boolean; alt?: string } = {},
): Node {
  const styles: Record<string, string> = {
    width: px(opts.w ?? DEFAULT_IMAGE.w),
    height: px(opts.h ?? DEFAULT_IMAGE.h),
    'object-fit': 'cover',
    display: 'block',
  };
  if (opts.absolute) {
    styles.position = 'absolute';
    styles.left = px(opts.x ?? 0);
    styles.top = px(opts.y ?? 0);
  }
  return createNodeFromTag('img', {
    name: opts.alt || 'Imagem',
    src,
    attrs: { alt: opts.alt ?? '' },
    styles,
  });
}
