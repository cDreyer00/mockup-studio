import { describe, expect, it } from 'vitest';
import { applyOp } from './apply.js';
import { createDocument, createNodeFromTag } from './document.js';
import type { Document, Node } from './types.js';

/** 6 frames x 50 nodes (300 nodes) with realistic styles. */
function bigDoc(): Document {
  const doc = createDocument('Perf', { id: 'doc_perf0001' });
  for (let f = 0; f < 6; f++) {
    const frame = createNodeFromTag('div', {
      isRoot: true,
      name: `Frame ${f}`,
      position: { x: f * 1500, y: 0 },
      styles: { width: '1440px', height: '900px', background: '#ffffff', display: 'flex' },
    });
    frame.id = `fr_perf${f}aaa`;
    for (let i = 0; i < 49; i++) {
      const n: Node = createNodeFromTag(i % 3 === 0 ? 'p' : 'div', {
        text: i % 3 === 0 ? 'Sample text for the mockup' : undefined,
        styles: {
          display: 'flex',
          'flex-direction': 'column',
          gap: '16px',
          padding: '24px 32px',
          'font-family': 'Inter, sans-serif',
          'font-size': '16px',
          color: '#1a1a2e',
          'background-color': '#f5f5fa',
          'border-radius': '12px',
          'box-shadow': '0 4px 12px rgba(0,0,0,0.12)',
        },
      });
      n.id = `el_perf${f}x${String(i).padStart(2, '0')}`;
      frame.children.push(n);
    }
    doc.pages[0]!.frames.push(frame);
  }
  return doc;
}

function avgMs(fn: () => void, iterations = 100): number {
  for (let i = 0; i < 5; i++) fn(); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - t0) / iterations;
}

describe('applyOp performance (~300 nodes)', () => {
  it('measures applyOp, stringify and clone', () => {
    const doc = bigDoc();
    const id = 'el_perf2x10';
    const r = {
      updateStyles: avgMs(() =>
        applyOp(doc, { type: 'updateStyles', nodeIds: [id], styles: { color: 'red' } }),
      ),
      setPosition: avgMs(() =>
        applyOp(doc, {
          type: 'setPosition',
          changes: [{ nodeId: 'fr_perf1aaa', position: { x: 5, y: 7 } }],
        }),
      ),
      moveNodes: avgMs(() =>
        applyOp(doc, { type: 'moveNodes', nodeIds: [id], parentId: 'fr_perf3aaa', index: 0 }),
      ),
      stringify: avgMs(() => void JSON.stringify(doc)),
      cloneJson: avgMs(() => void (JSON.parse(JSON.stringify(doc)) as Document)),
      cloneStructured: avgMs(() => void structuredClone(doc)),
    };
    const fmt = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, `${v.toFixed(3)} ms`]));
    console.log('[perf] 300 nodes, average of 100 iterations:', JSON.stringify(fmt));
    expect(r.updateStyles).toBeLessThan(16);
    expect(r.setPosition).toBeLessThan(16);
    expect(r.moveNodes).toBeLessThan(16);
    expect(r.stringify).toBeLessThan(16);
  });
});
