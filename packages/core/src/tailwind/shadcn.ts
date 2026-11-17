/**
 * shadcn/ui preset ("neutral" theme from shadcn v4, MIT) as document tokens: shadcn components
 * use classes such as `bg-primary`, `text-muted-foreground` and `border-input`, which only
 * exist with these variables in `@theme`. `import_component` creates the missing tokens.
 */
import type { Op } from '../ops.js';
import type { Document, Theme } from '../types.js';

/** Light theme (base) and dark theme (`dark` theme) colors. */
const COLORS: [name: string, light: string, dark: string][] = [
  ['background', 'oklch(1 0 0)', 'oklch(0.145 0 0)'],
  ['foreground', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)'],
  ['card', 'oklch(1 0 0)', 'oklch(0.205 0 0)'],
  ['card-foreground', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)'],
  ['popover', 'oklch(1 0 0)', 'oklch(0.205 0 0)'],
  ['popover-foreground', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)'],
  ['primary', 'oklch(0.205 0 0)', 'oklch(0.922 0 0)'],
  ['primary-foreground', 'oklch(0.985 0 0)', 'oklch(0.205 0 0)'],
  ['secondary', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)'],
  ['secondary-foreground', 'oklch(0.205 0 0)', 'oklch(0.985 0 0)'],
  ['muted', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)'],
  ['muted-foreground', 'oklch(0.556 0 0)', 'oklch(0.708 0 0)'],
  ['accent', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)'],
  ['accent-foreground', 'oklch(0.205 0 0)', 'oklch(0.985 0 0)'],
  ['destructive', 'oklch(0.577 0.245 27.325)', 'oklch(0.704 0.191 22.216)'],
  ['border', 'oklch(0.922 0 0)', 'oklch(1 0 0 / 10%)'],
  ['input', 'oklch(0.922 0 0)', 'oklch(1 0 0 / 15%)'],
  ['ring', 'oklch(0.708 0 0)', 'oklch(0.556 0 0)'],
];

/** shadcn radii (relative to `--radius`). */
const RADII: Record<string, string> = {
  '--radius': '0.625rem',
  '--radius-sm': 'calc(var(--radius) - 4px)',
  '--radius-md': 'calc(var(--radius) - 2px)',
  '--radius-lg': 'var(--radius)',
  '--radius-xl': 'calc(var(--radius) + 4px)',
};

export const SHADCN_COLOR_NAMES = COLORS.map(([n]) => n);

/** Preset base tokens (light `--color-*` and radii). */
export function shadcnTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, light] of COLORS) out[`--color-${n}`] = light;
  Object.assign(out, RADII);
  return out;
}

/** Overrides for the `dark` theme. */
export function shadcnDarkOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, , dark] of COLORS) out[`--color-${n}`] = dark;
  return out;
}

const UTILITY_PREFIX =
  '(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|from|via|to|divide|placeholder|accent|caret|decoration|shadow|inset-ring)';
const SHADCN_CLASS_RE = new RegExp(
  `^-?${UTILITY_PREFIX}-(${SHADCN_COLOR_NAMES.join('|')})(?:/\\S+)?!?$`,
);

/** Does the class (with or without variants) use a shadcn preset color? */
export function usesShadcnColor(cls: string): boolean {
  const cut = cls.lastIndexOf(':');
  const utility = (cut === -1 ? cls : cls.slice(cut + 1)).replace(/^!/, '');
  return SHADCN_CLASS_RE.test(utility);
}

/**
 * Ops that create the preset tokens the document does not have yet (and the `dark` theme, if it does not
 * exist). Already defined tokens are left untouched. Empty list = nothing to do.
 */
export function planShadcnTokens(doc: Document): { ops: Op[]; created: string[] } {
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(shadcnTokens())) if (!(k in doc.tokens)) set[k] = v;
  const created = Object.keys(set);
  const ops: Op[] = [];
  if (created.length > 0) {
    ops.push({ type: 'setTokens', set });
    const meta: Record<string, { group: string }> = {};
    for (const k of created) meta[k] = { group: k.startsWith('--radius') ? 'radius' : 'color' };
    ops.push({ type: 'setTokenMeta', set: meta });
  }
  const themes: Theme[] = (doc.themes ?? []).map((t) => ({ ...t, overrides: { ...t.overrides } }));
  let dark = themes.find((t) => t.name === 'dark');
  if (!dark) {
    dark = { name: 'dark', overrides: {} };
    themes.push(dark);
  }
  let changedTheme = false;
  for (const [k, v] of Object.entries(shadcnDarkOverrides())) {
    if (created.includes(k) && !(k in dark.overrides)) {
      dark.overrides[k] = v;
      changedTheme = true;
    }
  }
  if (changedTheme) ops.push({ type: 'setThemes', themes });
  return { ops, created };
}
