/** Listas curadas de propriedades CSS lidas do estilo computado na captura. */

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type Side = (typeof SIDES)[number];
export const SIDE_LIST: readonly Side[] = SIDES;

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
export const CORNER_LIST = CORNERS;

/** Propriedades emitidas quando o computado difere do padrão da tag (não herdadas). */
export const DIFF_PROPS = [
  'display',
  'z-index',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'order',
  'align-items',
  'align-self',
  'align-content',
  'justify-content',
  'justify-items',
  'justify-self',
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-columns',
  'grid-auto-rows',
  'grid-auto-flow',
  'grid-column',
  'grid-row',
  'float',
  'clear',
  'box-shadow',
  'filter',
  'backdrop-filter',
  'mix-blend-mode',
  'clip-path',
  'object-fit',
  'object-position',
  'aspect-ratio',
  'opacity',
  'text-overflow',
  'vertical-align',
  '-webkit-line-clamp',
  '-webkit-box-orient',
] as const;

/** Herdadas: na raiz comparam com o body dos padrões; nos descendentes, com o pai. */
export const INHERITED_PROPS = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-transform',
  'text-indent',
  'white-space',
  'text-shadow',
  'visibility',
  'list-style-type',
  'list-style-position',
  'word-break',
  'overflow-wrap',
] as const;

/** Todas as propriedades lidas (inclui as que têm tratamento especial). */
export const ALL_PROPS: readonly string[] = [
  ...DIFF_PROPS,
  ...INHERITED_PROPS,
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'gap',
  'row-gap',
  'column-gap',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'box-sizing',
  'overflow-x',
  'overflow-y',
  ...SIDES.map((s) => `margin-${s}`),
  ...SIDES.map((s) => `padding-${s}`),
  ...SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  ...CORNERS.map((c) => `border-${c}-radius`),
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'background-clip',
  'background-origin',
  'background-attachment',
  '-webkit-background-clip',
  'outline-width',
  'outline-style',
  'outline-color',
  'outline-offset',
  'transform',
  'transform-origin',
  'text-decoration-line',
  'text-decoration-color',
  'text-decoration-style',
  'text-decoration-thickness',
  '-webkit-text-fill-color',
];

/** Tags de elementos substituídos: recebem width/height em px sempre. */
export const REPLACED_TAGS = new Set([
  'img',
  'svg',
  'video',
  'canvas',
  'input',
  'textarea',
  'select',
  'iframe',
  'object',
  'embed',
]);

/** Tags que viram um `div` placeholder cinza com o mesmo tamanho. */
export const PLACEHOLDER_NAMES: Record<string, string> = {
  iframe: 'Iframe',
  object: 'Objeto',
  embed: 'Embed',
  video: 'Vídeo',
  canvas: 'Canvas',
  audio: 'Áudio',
};

/** Elementos que nunca viram nós. */
export const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'head',
  'title',
  'base',
  'source',
  'track',
  'param',
  'wbr',
  'datalist',
  'map',
  'area',
]);

/** Atributos copiados do DOM para o nó. */
export const KEEP_ATTRS = [
  'alt',
  'title',
  'aria-label',
  'role',
  'type',
  'placeholder',
  'name',
  'target',
  'rel',
  'colspan',
  'rowspan',
] as const;
