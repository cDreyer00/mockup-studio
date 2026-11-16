import { findNode } from './document.js';
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

/** Estilos próprios + propriedades herdadas dos ancestrais, com `var()` resolvido. */
export function getComputedLike(doc: Document, nodeId: string): Record<string, string> {
  const path = findNode(doc, nodeId);
  if (!path) throw new Error(`Nó "${nodeId}" não encontrado`);
  const vars: Record<string, string> = { ...doc.tokens };
  const result: Record<string, string> = {};
  for (const ancestor of path.ancestors) {
    for (const [k, v] of Object.entries(ancestor.style)) {
      if (k.startsWith('--')) vars[k] = v;
      else if ((INHERITED_PROPS as readonly string[]).includes(k)) result[k] = v;
    }
  }
  for (const [k, v] of Object.entries(path.node.style)) {
    if (k.startsWith('--')) vars[k] = v;
    result[k] = v;
  }
  for (const k of Object.keys(result)) result[k] = resolveVars(result[k], vars);
  return result;
}
