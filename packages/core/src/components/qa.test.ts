import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOp } from '../apply.js';
import { createDocument, createNodeFromTag } from '../index.js';
import { History } from '../history.js';
import type { Op } from '../ops.js';
import { exportHtml } from '../export/html.js';
import { exportReact } from '../export/react.js';
import { exportSvg } from '../export/svg.js';
import { exportTailwind } from '../export/tailwind.js';
import { parseDocument, serializeDocument } from '../schema.js';
import type { Document, Node } from '../types.js';
import { expandDocument, expandInstance } from './expand.js';
import { createComponentOps, detachInstanceOps, importKitOps, instanceNodeFor } from './plan.js';

const kit = parseDocument(
  fs.readFileSync(new URL('../../../../kits/shadcn-like.mockup.json', import.meta.url), 'utf8'),
);

function base(): { doc: Document; frameId: string } {
  const doc = createDocument('QA');
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Tela',
    styles: { width: '800px', height: '600px' },
    position: { x: 0, y: 0 },
  });
  doc.pages[0]!.frames.push(frame);
  return { doc, frameId: frame.id };
}

const strip = (d: Document): unknown => {
  const c = structuredClone(d);
  c.meta.updatedAt = '';
  return c;
};

function importAll(doc: Document): Document {
  const h = new History(doc);
  h.apply(importKitOps(doc, kit, 'shadcn-like').ops);
  return h.doc;
}

const firstFrame = (d: Document): Node => d.pages[0]!.frames[0]!;

describe('QA: undo/redo em sequência longa misturando ops de componente e comuns', () => {
  it('cada passo desfaz e refaz exatamente (createComponent, detach, estilo em id virtual)', () => {
    const { doc, frameId } = base();
    const h = new History(doc);
    const snaps: unknown[] = [strip(h.doc)];
    const step = (ops: Op[]): void => {
      h.apply(ops);
      snaps.push(strip(h.doc));
    };

    step(importKitOps(h.doc, kit, 'shadcn-like').ops);
    const btn = instanceNodeFor(h.doc, 'shadcn-like/Button', {
      props: { variant: 'outline', label: 'Salvar' },
    });
    step([{ type: 'createNode', parentId: frameId, node: btn }]);
    const plain = createNodeFromTag('div', { name: 'Caixa', styles: { padding: '8px' } });
    step([{ type: 'createNode', parentId: frameId, node: plain }]);
    step([{ type: 'updateStyles', nodeIds: [plain.id], styles: { background: '#eeeeee' } }]);
    step([{ type: 'setInstanceProps', changes: [{ nodeId: btn.id, set: { label: 'Ir' } }] }]);
    step([
      { type: 'updateStyles', nodeIds: [`${btn.id}/tx_sbtnlabl`], styles: { color: '#ff0000' } },
    ]);
    const made = createComponentOps(h.doc, plain.id, { name: 'Caixa' });
    expect(made.ops).toHaveLength(3);
    step(made.ops);
    step([
      { type: 'createNode', parentId: frameId, node: instanceNodeFor(h.doc, made.componentId) },
    ]);
    step(detachInstanceOps(h.doc, btn.id));
    step([{ type: 'updateStyles', nodeIds: [frameId], styles: { background: '#fafafa' } }]);

    const total = snaps.length - 1;
    for (let i = total; i > 0; i--) {
      h.undo();
      expect(strip(h.doc), `undo passo ${i}`).toEqual(snaps[i - 1]);
    }
    expect(h.canUndo).toBe(false);
    for (let i = 1; i <= total; i++) {
      h.redo();
      expect(strip(h.doc), `redo passo ${i}`).toEqual(snaps[i]);
    }
    expect(h.canRedo).toBe(false);
    expect(() => parseDocument(serializeDocument(h.doc))).not.toThrow();
  });
});

describe('QA: componente deletado, aninhamento e ciclos', () => {
  it('instância de componente ausente vira placeholder e exporta sem quebrar', () => {
    let { doc } = base();
    const frameId = firstFrame(doc).id;
    doc = importAll(doc);
    const inst = instanceNodeFor(doc, 'shadcn-like/Button', { props: { label: 'X' } });
    doc = applyOp(doc, { type: 'createNode', parentId: frameId, node: inst }).doc;
    // componente removido por fora (edição manual do arquivo)
    const broken = structuredClone(doc);
    broken.components = broken.components!.filter((c) => c.name !== 'Button');
    const out = expandInstance(broken, firstFrame(broken).children[0]!, { warnings: [] });
    expect(out.children[0]!.text).toBe('Componente ausente');
    expect(exportHtml(broken)).toContain('Componente ausente');
    expect(() => exportTailwind(broken)).not.toThrow();
    expect(() => exportSvg(broken, { nodeId: frameId })).not.toThrow();
    expect(() => exportReact(broken, { nodeId: frameId } as never)).not.toThrow();
  });

  it('deleteComponent recusa com instância viva e aceita depois de destacá-la', () => {
    let { doc } = base();
    const frameId = firstFrame(doc).id;
    doc = importAll(doc);
    const button = doc.components!.find((c) => c.name === 'Button')!;
    const inst = instanceNodeFor(doc, button.id);
    doc = applyOp(doc, { type: 'createNode', parentId: frameId, node: inst }).doc;
    expect(() => applyOp(doc, { type: 'deleteComponent', componentId: button.id })).toThrow();
    doc = applyOp(doc, { type: 'deleteNodes', nodeIds: [inst.id] }).doc;
    // outros componentes do kit podem usar Button por dentro: se usarem, segue recusado
    const used = doc.components!.some(
      (c) => c.id !== button.id && JSON.stringify(c.root).includes(`"componentId":"${button.id}"`),
    );
    if (!used) {
      expect(
        applyOp(doc, { type: 'deleteComponent', componentId: button.id }).doc.components,
      ).not.toContainEqual(expect.objectContaining({ id: button.id }));
    } else {
      expect(() => applyOp(doc, { type: 'deleteComponent', componentId: button.id })).toThrow();
    }
  });

  it('updateComponent que criaria ciclo (Button dentro de Card, que já usa Button) é recusado', () => {
    let { doc } = base();
    doc = importAll(doc);
    const button = doc.components!.find((c) => c.name === 'Button')!;
    const card = doc.components!.find((c) => c.name === 'Card')!;
    const withInstance = (componentId: string, id: string): Node => {
      const root = structuredClone(button.root);
      root.children.push({
        ...createNodeFromTag('div', { name: 'in' }),
        id,
        type: 'instance',
        componentId,
      });
      return root;
    };
    expect(() =>
      applyOp(doc, {
        type: 'updateComponent',
        componentId: button.id,
        root: withInstance(card.id, 'in_qa_loop0001'),
      }),
    ).toThrow(/ciclo/i);
    expect(() =>
      applyOp(doc, {
        type: 'updateComponent',
        componentId: button.id,
        root: withInstance(button.id, 'in_qa_self0001'),
      }),
    ).toThrow(/ciclo/i);
  });
});

describe('QA: props ausentes ou de tipo errado', () => {
  it('objeto numa prop é recusado; arquivo com props erradas carrega e exporta sem lançar', () => {
    const { doc: doc0, frameId } = base();
    let doc = doc0;
    doc = importAll(doc);
    const inst = instanceNodeFor(doc, 'shadcn-like/Button');
    doc = applyOp(doc, { type: 'createNode', parentId: frameId, node: inst }).doc;
    expect(() =>
      applyOp(doc, {
        type: 'setInstanceProps',
        changes: [{ nodeId: inst.id, set: { label: { a: 1 } as never } }],
      }),
    ).toThrow();

    const raw = JSON.parse(serializeDocument(doc)) as Document;
    (raw.pages[0]!.frames[0]!.children[0] as { props?: unknown }).props = {
      label: 123,
      variant: 'inexistente',
      fantasma: true,
    };
    const loaded = parseDocument(raw);
    expect(() => exportHtml(loaded)).not.toThrow();
    const shown = expandInstance(loaded, firstFrame(loaded).children[0]!, { warnings: [] });
    expect(JSON.stringify(shown)).not.toContain('{{label}}');
  });

  it('instância sem props usa os padrões', () => {
    const { doc: doc0, frameId } = base();
    let doc = doc0;
    doc = importAll(doc);
    const inst = instanceNodeFor(doc, 'shadcn-like/Button');
    expect(inst.props ?? {}).toEqual({});
    doc = applyOp(doc, { type: 'createNode', parentId: frameId, node: inst }).doc;
    const out = expandInstance(doc, firstFrame(doc).children[0]!, { warnings: [] });
    expect(JSON.stringify(out)).not.toContain('{{');
  });
});

describe('QA: documentos antigos sem components', () => {
  it('carregam iguais, não ganham a chave components e exportam como antes', () => {
    const { doc, frameId } = base();
    const text = serializeDocument(doc);
    expect(text).not.toContain('"components"');
    const loaded = parseDocument(text);
    expect(loaded.components).toBeUndefined();
    expect(serializeDocument(loaded)).toBe(text);
    expect(expandDocument(loaded)).toBe(loaded);
    expect(exportHtml(loaded)).toBe(exportHtml(doc));
    expect(() => exportTailwind(loaded)).not.toThrow();
    expect(() => exportSvg(loaded, { nodeId: frameId })).not.toThrow();
  });
});

describe('QA: documento com instâncias nos exportadores', () => {
  it('HTML, Tailwind, SVG e React não deixam placeholders soltos', () => {
    const { doc: doc0, frameId } = base();
    let doc = doc0;
    doc = importAll(doc);
    for (const props of [
      { variant: 'outline', label: 'A' },
      { label: 'B' },
      { variant: 'ghost' },
    ]) {
      const inst = instanceNodeFor(doc, 'shadcn-like/Button', { props });
      doc = applyOp(doc, { type: 'createNode', parentId: frameId, node: inst }).doc;
    }
    expect(exportHtml(doc)).not.toContain('{{');
    expect(exportTailwind(doc)).not.toContain('{{');
    expect(exportSvg(doc, { nodeId: frameId })).not.toContain('{{');
    expect(JSON.stringify(exportReact(doc, { nodeId: frameId } as never))).toContain('Button');
  });
});
