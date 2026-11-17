import { describe, expect, it } from 'vitest';
import { createDocument, createNodeFromTag } from '../document.js';
import { fontFaceCss } from '../fonts.js';
import type { Document } from '../types.js';
import { exportHtml } from './html.js';
import { exportReact } from './react.js';
import { exportSvg } from './svg.js';
import { exportTailwind, tailwindThemeCss } from './tailwind.js';

function docWithFont(): { doc: Document; frameId: string } {
  const doc = createDocument('Fonts', { id: 'doc_fonts001' });
  const frame = createNodeFromTag('div', { isRoot: true });
  frame.children = [createNodeFromTag('p', { text: 'Hi' })];
  doc.pages[0]!.frames.push(frame);
  doc.fonts = [
    { family: 'Inter', source: 'file', files: ['fonts/inter.woff2'], weights: [400, 500, 700] },
  ];
  return { doc, frameId: frame.id };
}

describe('font-display', () => {
  it('fontFaceCss uses block by default (deterministic render) and accepts swap', () => {
    const { doc } = docWithFont();
    const urlOf = (f: string) => f;
    expect(fontFaceCss(doc, urlOf)).toContain('font-display:block');
    expect(fontFaceCss(doc, urlOf, 'swap')).toContain('font-display:swap');
    expect(fontFaceCss(doc, urlOf, 'swap')).toContain('font-weight:400 700');
  });

  it('delivery formats export swap, never block', () => {
    const { doc, frameId } = docWithFont();
    const outs = [
      exportHtml(doc, { nodeIds: [frameId] }),
      exportTailwind(doc, { nodeIds: [frameId] }),
      tailwindThemeCss(doc),
      exportSvg(doc, { nodeId: frameId, resolveImage: (s) => s }),
      exportSvg(doc, { nodeId: frameId }),
      JSON.stringify(exportReact(doc, { nodeId: frameId, styles: 'inline' })),
      JSON.stringify(exportReact(doc, { nodeId: frameId })),
    ];
    for (const o of outs) {
      expect(o).not.toContain('font-display:block');
      expect(o).toContain('font-display:swap');
    }
  });
});
