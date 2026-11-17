/** Conversion of effect parameters (UI text ↔ typed catalog value). Pure logic. */
import type { EffectParamDef, MediaParamValue } from '@mockup/core';

/** Rounds to the `step` (relative to `min`) and clamps to `min`/`max`; avoids floating-point noise. */
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

/** Converts the typed text to the parameter value; `null` if invalid. */
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

/** Current parameter value, falling back to the catalog default. */
export function paramValue(
  def: EffectParamDef,
  params: Record<string, MediaParamValue>,
): MediaParamValue {
  return params[def.name] ?? def.default;
}

/** New params with `name` replaced; the others stay as they are. */
export function withParam(
  params: Record<string, MediaParamValue>,
  name: string,
  value: MediaParamValue,
): Record<string, MediaParamValue> {
  return { ...params, [name]: value };
}
