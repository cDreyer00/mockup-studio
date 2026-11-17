import { memo, useMemo } from 'react';
import { themeRulesCss } from '@mockup/core';
import type { Document } from '@mockup/core';

/** Scope selector for theme rules: `.cv-world ` (does not leak into the editor UI). */
export const THEME_SCOPE = '.cv-world ';

/**
 * Injects `.cv-world [data-theme="x"] { --token: ... }` for each theme of the document. A frame's
 * theme is the `data-theme` attribute of the element itself, so the CSS is the same as the HTML export.
 * Memoized by `tokens`/`themes`: only recomputes when the token system changes.
 */
export const ThemeStyles = memo(function ThemeStyles({
  tokens,
  themes,
}: Pick<Document, 'tokens' | 'themes'>) {
  const css = useMemo(
    () => themeRulesCss({ tokens, themes } as Document, { scope: THEME_SCOPE }),
    [tokens, themes],
  );
  if (!css) return null;
  return <style data-testid="theme-styles">{css}</style>;
});
