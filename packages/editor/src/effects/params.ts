/** Conversão de parâmetros de efeito (texto da interface ↔ valor tipado do catálogo). Lógica pura. */
import type { EffectParamDef, MediaParamValue } from '@mockup/core';

/** Arredonda ao passo `step` (relativo a `min`) e limita a `min`/`max`; evita ruído de ponto flutuante. */
export function snapNumber(def: Pick<EffectParamDef, 'min' | 'max' | 'step'>, n: number): number {
  let v = n;
  if (def.step && def.step > 0) {
    const base = def.min ?? 0;
    v = base + Math.round((v - base) / def.step) * def.step;
  }
  if (def.min !== undefined) v = Math.max(def.min, v);
  if (def.max !== undefined) v = Math.min(def.max, v);
  return Number(v.toFixed(6));
}

/** Converte o texto digitado para o valor do parâmetro; `null` se inválido. */
export function parseParamValue(def: EffectParamDef, raw: string): MediaParamValue | null {
  const text = raw.trim();
  switch (def.type) {
    case 'number': {
      if (text === '') return null;
      const n = Number(text.replace(',', '.'));
      return Number.isFinite(n) ? snapNumber(def, n) : null;
    }
    case 'color':
      return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ? text.toLowerCase() : null;
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : null;
    case 'select':
      return def.options?.includes(text) ? text : null;
  }
}

/** Valor atual do parâmetro com fallback para o padrão do catálogo. */
export function paramValue(
  def: EffectParamDef,
  params: Record<string, MediaParamValue>,
): MediaParamValue {
  return params[def.name] ?? def.default;
}

/** Parâmetros novos com `name` trocado; os demais ficam como estão. */
export function withParam(
  params: Record<string, MediaParamValue>,
  name: string,
  value: MediaParamValue,
): Record<string, MediaParamValue> {
  return { ...params, [name]: value };
}
