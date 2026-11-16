/** Leitura/escrita de propriedades de caixa (padding, margin, border-radius) sem conflito shorthand/longhand. */
import { parseBox, serializeBox } from './css';
import type { Box } from './css';

export interface BoxSpec {
  /** Shorthand (`padding`). */
  prop: string;
  /** Longhands na ordem top, right, bottom, left (para radius: TL, TR, BR, BL). */
  sides: [string, string, string, string];
}

export const PADDING: BoxSpec = {
  prop: 'padding',
  sides: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
};
export const MARGIN: BoxSpec = {
  prop: 'margin',
  sides: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
};
export const RADIUS: BoxSpec = {
  prop: 'border-radius',
  sides: [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],
};

const KEYS = ['top', 'right', 'bottom', 'left'] as const;

/** Valores efetivos dos 4 lados: shorthand como base, longhands por cima; '' = ausente. */
export function readBox(style: Record<string, string>, spec: BoxSpec): Box {
  const base = parseBox(style[spec.prop]) ?? { top: '', right: '', bottom: '', left: '' };
  const out = { ...base };
  KEYS.forEach((k, i) => {
    const v = style[spec.sides[i]!];
    if (v !== undefined && v !== '') out[k] = v;
  });
  return out;
}

/**
 * Estilos para gravar o box: sempre o shorthand (lados vazios viram `0`) e remove os longhands,
 * de modo que nunca coexistam. Box totalmente vazio remove tudo.
 */
export function writeBox(
  style: Record<string, string>,
  spec: BoxSpec,
  box: Box,
): { set: Record<string, string>; unset: string[] } {
  const present = spec.sides.filter((s) => s in style);
  const empty = KEYS.every((k) => box[k] === '');
  if (empty) {
    return { set: {}, unset: [...(spec.prop in style ? [spec.prop] : []), ...present] };
  }
  const full = Object.fromEntries(
    KEYS.map((k) => [k, box[k] === '' ? '0' : box[k]]),
  ) as unknown as Box;
  return { set: { [spec.prop]: serializeBox(full) }, unset: present };
}

/** Define todos os lados com o mesmo valor ('' remove). */
export function uniformBox(value: string): Box {
  return { top: value, right: value, bottom: value, left: value };
}
