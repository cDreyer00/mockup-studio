/** Documentos de teste do editor. */
import { createDocument, createNodeFromTag } from '@mockup/core';
import type { Document, Node } from '@mockup/core';

/** Doc com 1 frame flex (coluna) contendo 3 filhos e 1 filho absoluto. */
export function makeDoc(): { doc: Document; frame: Node; a: Node; b: Node; c: Node; abs: Node } {
  const doc = createDocument('Teste');
  const a = createNodeFromTag('div', { name: 'A', styles: { width: '10px' } });
  const b = createNodeFromTag('p', { name: 'B', text: 'b' });
  const c = createNodeFromTag('div', { name: 'C' });
  c.children.push(createNodeFromTag('span', { name: 'C1', text: 'c1' }));
  const abs = createNodeFromTag('div', {
    name: 'Abs',
    styles: { position: 'absolute', left: '10px', top: '20px' },
  });
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Frame',
    styles: {
      width: '400px',
      height: '300px',
      display: 'flex',
      'flex-direction': 'column',
      gap: '8px',
    },
    position: { x: 100, y: 50 },
    children: [a, b, c, abs],
  });
  doc.pages[0]!.frames.push(frame);
  return { doc, frame, a, b, c, abs };
}

/** Documento grande: `frames` frames × `perFrame` nós (para medições). */
export function makeBigDoc(frames = 6, perFrame = 50): Document {
  const doc = createDocument('Grande');
  for (let f = 0; f < frames; f++) {
    const children: Node[] = [];
    for (let i = 0; i < perFrame - 1; i++) {
      children.push(
        i % 3 === 0
          ? createNodeFromTag('p', {
              text: `Texto ${f}-${i}`,
              styles: { 'font-size': '16px', color: '#222', 'line-height': '1.4' },
            })
          : createNodeFromTag('div', {
              styles: {
                width: '120px',
                height: '40px',
                background: '#eee',
                'border-radius': '6px',
                padding: '8px',
              },
            }),
      );
    }
    doc.pages[0]!.frames.push(
      createNodeFromTag('div', {
        isRoot: true,
        name: `Frame ${f}`,
        styles: {
          width: '1440px',
          height: '900px',
          display: 'flex',
          'flex-wrap': 'wrap',
          gap: '12px',
          background: '#fff',
        },
        position: { x: f * 1600, y: 0 },
        children,
      }),
    );
  }
  return doc;
}
