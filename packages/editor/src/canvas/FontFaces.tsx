import { useMemo } from 'react';
import { fontFaceCss } from '@mockup/core';
import type { FontRef } from '@mockup/core';

/** CSS `@font-face` das fontes embutidas do documento, com os arquivos em `/assets/<docId>/...`. */
export function embeddedFontCss(fonts: FontRef[], docId: string): string {
  return fontFaceCss({ fonts }, (f) => '/assets/' + docId + '/' + f);
}

/** `<style>` com as fontes embutidas; recalcula só quando `doc.fonts` muda. */
export function FontFaces({ fonts, docId }: { fonts: FontRef[] | undefined; docId: string }) {
  const css = useMemo(() => (fonts && docId ? embeddedFontCss(fonts, docId) : ''), [fonts, docId]);
  return css ? <style data-testid="doc-fonts">{css}</style> : null;
}
