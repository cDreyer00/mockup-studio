/** Documentos de teste do editor. */
import {
  applyOps,
  createComponentOps,
  createDocument,
  createNodeFromTag,
  instanceNodeFor,
} from '@mockup/core';
import type { Document, Node, Op } from '@mockup/core';

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

/**
 * Doc com um componente "Card" (texto `{{label}}` e slot `content`) e 3 instâncias no frame:
 * `in_card0001` (o nó original, sem props), `in_card0002` (label B) e `in_card0003` (label C).
 */
export function makeComponentDoc(): {
  doc: Document;
  frameId: string;
  componentId: string;
  instanceIds: string[];
  /** Ids dos nós do principal: raiz, texto e contêiner do slot. */
  main: { rootId: string; textId: string; slotId: string };
} {
  const doc = createDocument('Componentes');
  const text = createNodeFromTag('p', { name: 'Rótulo', text: '{{label}}' });
  const slot = createNodeFromTag('div', {
    name: 'Conteúdo',
    attrs: { 'data-slot': 'content' },
    children: [createNodeFromTag('span', { name: 'Padrão', text: 'padrão' })],
  });
  const card = createNodeFromTag('div', {
    name: 'Card',
    styles: { padding: '8px', background: '#ffffff' },
    children: [text, slot],
  });
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Frame',
    styles: { width: '600px', height: '400px', display: 'flex', 'flex-direction': 'column' },
    position: { x: 0, y: 0 },
    children: [card],
  });
  doc.pages[0]!.frames.push(frame);
  const created = createComponentOps(doc, card.id, {
    componentId: 'cp_card0001',
    instanceId: 'in_card0001',
  });
  let cur = applyOps(doc, created.ops).doc;
  const more: Op[] = ['B', 'C'].map((label, i) => ({
    type: 'createNode',
    parentId: frame.id,
    node: instanceNodeFor(cur, 'cp_card0001', { props: { label }, id: `in_card000${i + 2}` }),
  }));
  cur = applyOps(cur, more).doc;
  return {
    doc: cur,
    frameId: frame.id,
    componentId: 'cp_card0001',
    instanceIds: ['in_card0001', 'in_card0002', 'in_card0003'],
    main: { rootId: card.id, textId: text.id, slotId: slot.id },
  };
}
