import { evaluateCss } from './cssEval.js';
import { scopeChainFor, substituteVars } from './tokens.js';
import type { Document } from './types.js';

export const INHERITED_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'color',
  'text-align',
  'font-style',
  'text-transform',
] as const;

const MAX_DEPTH = 10;

function resolve(value: string, tokens: Record<string, string>, level: number): string {
  if (level > MAX_DEPTH) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('var(', i);
    if (start === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, start);
    let depth = 0;
    let end = -1;
    for (let j = start + 3; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')' && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      out += value.slice(start);
      break;
    }
    const inner = value.slice(start + 4, end);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    const found = tokens[name];
    if (found !== undefined) out += resolve(found, tokens, level + 1);
    else if (fallback !== undefined) out += resolve(fallback, tokens, level + 1);
    else out += value.slice(start, end + 1);
    i = end + 1;
  }
  return out;
}

/** Resolve `var(--x)` e `var(--x, fallback)` recursivamente (até 10 níveis). */
export function resolveVars(value: string, tokens: Record<string, string>): string {
  return resolve(value, tokens, 0);
}

/**
 * Estilos próprios + propriedades herdadas dos ancestrais, com `var()` resolvido como no CSS: cada
 * valor no escopo do nó que o declara (uma propriedade herdada chega ao descendente já calculada
 * no ancestral; um `data-theme` no descendente não a altera). O escopo inclui tokens base, tema
 * via `data-theme` e custom properties dos ancestrais; `calc()`/`color-mix()` são avaliados quando
 * possível. `theme` força um tema no próprio nó (como se ele tivesse `data-theme="<tema>"`);
 * `evaluate: false` mantém `calc()`/`color-mix()` como texto.
 */
export function getComputedLike(
  doc: Document,
  nodeId: string,
  opts: { theme?: string; evaluate?: boolean } = {},
): Record<string, string> {
  const chain = scopeChainFor(doc, nodeId, { theme: opts.theme });
  const result: Record<string, string> = {};
  const finish = (value: string, vars: Record<string, string>): string => {
    const v = substituteVars(value, (n) => vars[n]).value;
    return opts.evaluate === false ? v : evaluateCss(v);
  };
  for (const { node, vars } of chain.slice(0, -1)) {
    for (const [k, v] of Object.entries(node.style)) {
      if ((INHERITED_PROPS as readonly string[]).includes(k)) result[k] = finish(v, vars);
    }
  }
  const self = chain.at(-1)!;
  for (const [k, v] of Object.entries(self.node.style)) result[k] = finish(v, self.vars);
  return result;
}
