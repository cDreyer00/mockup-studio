import { describe, expect, it } from 'vitest';
import { applyOp } from '@mockup/core';
import type { Document } from '@mockup/core';
import { getIndex } from '../model/tree';
import { makeBigDoc } from '../test/fixtures';
import { mergeDoc } from './docStore';

/**
 * Cost, in the editor, of integrating a `doc:changed` of a document with 300 nodes:
 * JSON.parse of the message + structural sharing + node index.
 */
describe('doc:changed integration performance (300 nodes)', () => {
  it('stays well below one frame (16 ms)', () => {
    let doc: Document = makeBigDoc(6, 50);
    expect(getIndex(doc).nodes.size).toBe(300);
    const target = doc.pages[0]!.frames[2]!.children[10]!.id;
    const N = 100;
    let parse = 0;
    let merge = 0;
    let index = 0;
    for (let i = 0; i < N; i++) {
      const next = applyOp(doc, {
        type: 'updateStyles',
        nodeIds: [target],
        styles: { width: `${100 + i}px` },
      }).doc;
      const wire = JSON.stringify({ type: 'doc:changed', doc: next });
      let t = performance.now();
      const received = (JSON.parse(wire) as { doc: Document }).doc;
      parse += performance.now() - t;
      t = performance.now();
      const merged = mergeDoc(doc, received);
      merge += performance.now() - t;
      t = performance.now();
      getIndex(merged);
      index += performance.now() - t;
      // Only the changed frame loses its identity.
      expect(merged.pages[0]!.frames[0]).toBe(doc.pages[0]!.frames[0]);
      expect(merged.pages[0]!.frames[2]).not.toBe(doc.pages[0]!.frames[2]);
      doc = merged;
    }
    const ms = (v: number) => (v / N).toFixed(3);
    console.log(
      `[perf editor] 300 nodes: JSON.parse ${ms(parse)} ms, shareStructure ${ms(merge)} ms, index ${ms(index)} ms (average of ${N})`,
    );
    expect((parse + merge + index) / N).toBeLessThan(16);
  });
});
