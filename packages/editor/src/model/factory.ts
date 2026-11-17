/** Fábricas dos nós criados pelas ferramentas do editor (ids gerados pelo core). */
import { createNodeFromTag } from '@mockup/core';
import type { Node } from '@mockup/core';

export const DEFAULT_FRAME = { w: 1440, h: 900 };
export const DEFAULT_RECT = { w: 120, h: 120 };
export const DEFAULT_IMAGE = { w: 240, h: 160 };

const px = (n: number): string => `${Math.round(n)}px`;

let frameCounter = 0;

/**
 * Folhas que não viram frame raiz sozinhas: levadas para a raiz, ganham um frame em volta.
 * Instâncias de componente também (um frame raiz não pode ser instância).
 */
export function isLeafNode(node: Node): boolean {
  return (
    node.type === 'text' ||
    node.type === 'image' ||
    node.type === 'svg' ||
    node.type === 'instance' ||
    node.componentId !== undefined
  );
}

/** Recuo entre o frame que embrulha uma folha e o conteúdo. */
export const LEAF_FRAME_PADDING = 24;

/** Propriedades de posicionamento que a folha perde ao entrar no frame que a embrulha. */
export const POSITION_STYLE_KEYS = ['position', 'left', 'top', 'right', 'bottom'] as const;

/**
 * Frame raiz (vazio) que embrulha uma folha de `w`×`h`: mesmo nome, `padding` e tamanho com folga.
 * `x`/`y` são a posição do frame; o conteúdo fica `LEAF_FRAME_PADDING` para dentro.
 */
export function makeLeafFrame(
  leaf: Node,
  x: number,
  y: number,
  w: number,
  h: number,
  min = { w: 0, h: 0 },
): Node {
  const pad = LEAF_FRAME_PADDING * 2;
  const frame = makeFrame(x, y, Math.max(min.w, w + pad), Math.max(min.h, h + pad), leaf.name);
  frame.style.padding = px(LEAF_FRAME_PADDING);
  return frame;
}

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
