import { useMemo } from 'react';
import { documentBaseCss, documentBaseCssFor, fontFaceCss } from '@mockup/core';
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

/**
 * CSS base do documento (o mesmo do código exportado e do render), restrito ao mundo do canvas;
 * a tipografia padrão vai só nos frames, para o CSS da interface do editor não vazar no design.
 */
export const DOCUMENT_BASE_CSS = documentBaseCss('.cv-world', '.cv-world > [data-node-id]');

/** CSS base do documento; com cssBase: 'tailwind' inclui o preflight do Tailwind. */
export function DocumentBase({ cssBase }: { cssBase?: 'tailwind' }) {
  const css = useMemo(
    () =>
      cssBase
        ? documentBaseCssFor({ cssBase }, '.cv-world', '.cv-world > [data-node-id]')
        : DOCUMENT_BASE_CSS,
    [cssBase],
  );
  return <style data-testid="doc-base">{css}</style>;
}
