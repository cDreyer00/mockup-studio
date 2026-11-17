/**
 * Catálogo de efeitos: shaders GLSL próprios (fragment shaders WebGL 1) e partículas.
 * Fonte única para o editor, a página de render, o MCP (`list_effects`) e os exportadores.
 * Sem DOM e sem Node. CONTRATO (stub): a implementação completa substitui este arquivo.
 */
import type { EffectSpec, MediaParamValue } from '../types.js';

export type EffectCategory = 'shader' | 'particles';
export type EffectParamType = 'number' | 'color' | 'boolean' | 'select';

export interface EffectParamDef {
  /** Nome do parâmetro (camelCase), ex.: `speed`, `color1`. No shader vira o uniform `u_<name>`. */
  name: string;
  label: string;
  type: EffectParamType;
  default: MediaParamValue;
  min?: number;
  max?: number;
  step?: number;
  /** Opções de `select`. */
  options?: string[];
  description: string;
}

export interface EffectPreset {
  /** Id do preset (kebab-case), ex.: `aurora`. */
  name: string;
  label: string;
  params: Record<string, MediaParamValue>;
}

export interface EffectDef {
  kind: string;
  label: string;
  category: EffectCategory;
  description: string;
  params: EffectParamDef[];
  presets: EffectPreset[];
  /** Fragment shader GLSL ES 1.0 (só `shader`). */
  fragment?: string;
}

export const EFFECTS: readonly EffectDef[] = [];

export function getEffect(kind: string): EffectDef | undefined {
  return EFFECTS.find((e) => e.kind === kind);
}

export function effectKinds(): string[] {
  return EFFECTS.map((e) => e.kind);
}

/** Parâmetros completos: padrões do catálogo + valores válidos de `params` (números limitados a min/max). */
export function resolveEffectParams(
  kind: string,
  params: Record<string, MediaParamValue> = {},
): Record<string, MediaParamValue> {
  const def = getEffect(kind);
  if (!def) return { ...params };
  const out: Record<string, MediaParamValue> = {};
  for (const p of def.params) out[p.name] = params[p.name] ?? p.default;
  return out;
}

/** Problemas de `params` para `kind` (efeito inexistente, parâmetro desconhecido, tipo, faixa). Vazio = ok. */
export function effectParamsProblems(
  kind: string,
  _params: Record<string, MediaParamValue> = {},
): string[] {
  return getEffect(kind) ? [] : [`efeito inexistente: "${kind}"`];
}

/** Parâmetros de um preset (já resolvidos com os padrões) ou undefined. */
export function presetParams(
  kind: string,
  preset: string,
): Record<string, MediaParamValue> | undefined {
  const p = getEffect(kind)?.presets.find((x) => x.name === preset);
  return p ? resolveEffectParams(kind, p.params) : undefined;
}

/** CSS estático que aproxima o efeito (fundo de fallback para export sem JS, SVG e poster). */
export function effectFallbackCss(_spec: EffectSpec): Record<string, string> {
  return { background: '#1e1b4b' };
}
