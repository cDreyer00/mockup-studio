import { memo, useMemo } from 'react';
import { themeRulesCss } from '@mockup/core';
import type { Document } from '@mockup/core';

/** Seletor de escopo das regras de tema: `.cv-world ` (não vaza para a interface do editor). */
export const THEME_SCOPE = '.cv-world ';

/**
 * Injeta `.cv-world [data-theme="x"] { --token: ... }` para cada tema do documento. O tema de um
 * frame é o atributo `data-theme` do próprio elemento, então o CSS é o mesmo do export HTML.
 * Memoizado por `tokens`/`themes`: só recalcula quando o sistema de tokens muda.
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
