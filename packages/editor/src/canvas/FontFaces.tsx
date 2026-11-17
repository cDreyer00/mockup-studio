import { useMemo } from 'react';
import { documentBaseCss, documentBaseCssFor, fontFaceCss } from '@mockup/core';
import type { FontRef } from '@mockup/core';

/** CSS `@font-face` for the document's embedded fonts, with the files at `/assets/<docId>/...`. */
export function embeddedFontCss(fonts: FontRef[], docId: string): string {
  return fontFaceCss({ fonts }, (f) => '/assets/' + docId + '/' + f);
}

/** `<style>` with the embedded fonts; recomputes only when `doc.fonts` changes. */
export function FontFaces({ fonts, docId }: { fonts: FontRef[] | undefined; docId: string }) {
  const css = useMemo(() => (fonts && docId ? embeddedFontCss(fonts, docId) : ''), [fonts, docId]);
  return css ? <style data-testid="doc-fonts">{css}</style> : null;
}

/**
 * Document base CSS (the same as the exported code and the render), scoped to the canvas world;
 * the default typography goes only on the frames, so the editor UI CSS does not leak into the design.
 */
export const DOCUMENT_BASE_CSS = documentBaseCss('.cv-world', '.cv-world > [data-node-id]');

/** Document base CSS; with cssBase: 'tailwind' it includes the Tailwind preflight. */
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
