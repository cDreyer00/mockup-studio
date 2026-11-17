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

/** Resolves `var(--x)` and `var(--x, fallback)` recursively (up to 10 levels). */
export function resolveVars(value: string, tokens: Record<string, string>): string {
  return resolve(value, tokens, 0);
}

/**
 * Own styles + properties inherited from ancestors, with `var()` resolved as in CSS: each
 * value in the scope of the node that declares it (an inherited property reaches the descendant
 * already computed in the ancestor; a `data-theme` on the descendant does not change it). The scope
 * includes base tokens, the theme via `data-theme` and custom properties of the ancestors;
 * `calc()`/`color-mix()` are evaluated when possible. `theme` forces a theme on the node itself
 * (as if it had `data-theme="<theme>"`); `evaluate: false` keeps `calc()`/`color-mix()` as text.
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
