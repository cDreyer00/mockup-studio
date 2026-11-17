import { beforeAll, describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import { createDocument, createNodeFromTag, findNode } from '../document.js';
import type { Document, Node } from '../types.js';
import { detectTailwind, planSetClasses, type SetClassesMode } from './apply.js';
import { createTailwindEngine, type TailwindEngine } from './engine.js';

let engine: TailwindEngine;

beforeAll(async () => {
  engine = await createTailwindEngine(createDocument('plan'));
});

function fixture(): Document {
  const doc = createDocument('Plan', { id: 'doc_plan0001' });
  const frame = createNodeFromTag('div', {
    isRoot: true,
    styles: { width: '400px', height: '300px' },
  });
  frame.id = 'fr_plan0001';
  const card = createNodeFromTag('div', {
    styles: { padding: '1rem', 'background-color': '#fff' },
  });
  card.id = 'el_plan0001';
  card.classes = 'p-4 bg-white';
  frame.children = [card];
  doc.pages[0].frames.push(frame);
  return doc;
}

function plan(doc: Document, classes: string, mode: SetClassesMode, id = 'el_plan0001') {
  const node = findNode(doc, id)!.node;
  const root = id === 'fr_plan0001';
  const p = planSetClasses([{ node, root }], classes, engine, mode);
  const next = applyOps(doc, p.ops).doc;
  return { p, next, node: findNode(next, id)!.node as Node };
}

describe('planSetClasses', () => {
  it('replace: as classes passam a ser todo o estilo', () => {
    const { node, p } = plan(fixture(), 'flex gap-2 hover:bg-red-500', 'replace');
    expect(node.style).toEqual({ display: 'flex', gap: '0.5rem' });
    expect(node.states?.hover?.['background-color']).toBeDefined();
    expect(node.classes).toBe('flex gap-2 hover:bg-red-500');
    expect(p.classes.el_plan0001).toBe('flex gap-2 hover:bg-red-500');
  });

  it('replace no frame raiz mantém width/height', () => {
    const { node } = plan(fixture(), 'flex', 'replace', 'fr_plan0001');
    expect(node.style.width).toBe('400px');
    expect(node.style.height).toBe('300px');
    expect(node.style.display).toBe('flex');
  });

  it('add: acrescenta e troca as classes que tocam as mesmas propriedades', () => {
    const { node } = plan(fixture(), 'p-8 rounded-lg', 'add');
    expect(node.classes).toBe('bg-white p-8 rounded-lg');
    expect(node.style.padding).toBe('2rem');
    expect(node.style['border-radius']).toBe('0.5rem');
    expect(node.style['background-color']).toBe('#fff');
  });

  it('remove: tira as classes e o que só elas produziam', () => {
    const { node } = plan(fixture(), 'p-4', 'remove');
    expect(node.classes).toBe('bg-white');
    expect(node.style.padding).toBeUndefined();
    expect(node.style['background-color']).toBe('#fff');
  });

  it('remove limpa o estado quando a classe de variante sai', () => {
    const doc = fixture();
    const first = plan(doc, 'hover:bg-red-500', 'add');
    expect(first.node.states?.hover).toBeDefined();
    const second = plan(first.next, 'hover:bg-red-500', 'remove');
    expect(second.node.states).toBeUndefined();
  });

  it('é um undo só: o inverso restaura o documento', () => {
    const doc = fixture();
    const p = planSetClasses(
      [{ node: findNode(doc, 'el_plan0001')!.node, root: false }],
      'flex gap-2 md:hover:p-2',
      engine,
      'replace',
    );
    const r = applyOps(doc, p.ops);
    const back = applyOps(r.doc, r.inverse);
    const strip = (d: Document): unknown => ({ ...d, meta: { ...d.meta, updatedAt: '' } });
    expect(strip(back.doc)).toStrictEqual(strip(doc));
  });

  it('relata classes desconhecidas e não suportadas', () => {
    const { p } = plan(fixture(), 'foo-bar group-hover:p-2 p-2', 'add');
    expect(p.report.unknown).toContain('foo-bar');
    expect(p.report.unsupported.map((u) => u.cls)).toContain('group-hover:p-2');
  });

  it('classes dos filhos (space-y) vão para os filhos', () => {
    const doc = fixture();
    const parent = findNode(doc, 'fr_plan0001')!.node;
    const second = createNodeFromTag('div');
    second.id = 'el_plan0002';
    parent.children.push(second);
    const p = planSetClasses(
      [{ node: parent, root: true }],
      'flex flex-col space-y-2',
      engine,
      'add',
    );
    const next = applyOps(doc, p.ops).doc;
    expect(findNode(next, 'el_plan0001')!.node.style['margin-block-end']).toBe('0.5rem');
    expect(findNode(next, 'el_plan0002')!.node.style['margin-block-end']).toBeUndefined();
  });

  it('replace num nó absoluto mantém position/left/top', () => {
    const doc = fixture();
    const card = findNode(doc, 'el_plan0001')!.node;
    card.style = { ...card.style, position: 'absolute', left: '10px', top: '20px' };
    const { node } = plan(doc, 'p-2', 'replace');
    expect(node.style.position).toBe('absolute');
    expect(node.style.left).toBe('10px');
    expect(node.style.top).toBe('20px');
    expect(node.style['background-color']).toBeUndefined();
  });

  it('replace com classes que definem left não o sobrescreve com o antigo', () => {
    const doc = fixture();
    const card = findNode(doc, 'el_plan0001')!.node;
    card.style = { ...card.style, position: 'absolute', left: '10px', top: '20px' };
    const { node } = plan(doc, 'absolute left-4', 'replace');
    expect(node.style.left).toBe('1rem');
    expect(node.style.top).toBe('20px');
  });

  it('replace mantém o CSS sem classe equivalente', () => {
    const doc = fixture();
    const card = findNode(doc, 'el_plan0001')!.node;
    card.style = { ...card.style, 'grid-template-areas': '"a;b"' };
    expect(engine.nodeClasses(card).rest['grid-template-areas']).toBe('"a;b"');
    const { node } = plan(doc, 'p-2', 'replace');
    expect(node.style['grid-template-areas']).toBe('"a;b"');
    expect(node.style['background-color']).toBeUndefined();
  });

  describe('classes dos filhos ao sair', () => {
    function parentDoc(classes: string) {
      const doc = fixture();
      const parent = findNode(doc, 'fr_plan0001')!.node;
      const second = createNodeFromTag('div');
      second.id = 'el_plan0002';
      parent.children.push(second);
      const p0 = planSetClasses([{ node: parent, root: true }], classes, engine, 'add');
      const withKids = applyOps(doc, p0.ops).doc;
      return withKids;
    }
    const run = (doc: Document, classes: string, mode: SetClassesMode) => {
      const parent = findNode(doc, 'fr_plan0001')!.node;
      const p = planSetClasses([{ node: parent, root: true }], classes, engine, mode);
      return applyOps(doc, p.ops).doc;
    };

    it('remove space-y-4 limpa a margem dos filhos', () => {
      const doc = parentDoc('space-y-4');
      expect(findNode(doc, 'el_plan0001')!.node.style['margin-block-end']).toBe('1rem');
      const next = run(doc, 'space-y-4', 'remove');
      expect(findNode(next, 'el_plan0001')!.node.style['margin-block-end']).toBeUndefined();
    });

    it('replace space-y-4 por space-y-2 troca a margem', () => {
      const doc = parentDoc('space-y-4');
      const next = run(doc, 'space-y-2', 'replace');
      expect(findNode(next, 'el_plan0001')!.node.style['margin-block-end']).toBe('0.5rem');
    });

    it('replace sem classe de filhos limpa a margem', () => {
      const doc = parentDoc('space-y-4');
      const next = run(doc, 'flex', 'replace');
      expect(findNode(next, 'el_plan0001')!.node.style['margin-block-end']).toBeUndefined();
    });

    it('valor editado manualmente no filho é preservado', () => {
      const doc = parentDoc('space-y-4');
      findNode(doc, 'el_plan0001')!.node.style['margin-block-end'] = '7px';
      const next = run(doc, 'space-y-4', 'remove');
      expect(findNode(next, 'el_plan0001')!.node.style['margin-block-end']).toBe('7px');
    });
  });
});

describe('detectTailwind', () => {
  it('reconhece markup Tailwind', () => {
    const r = detectTailwind(
      '<div class="flex gap-4 p-4"><p class="text-sm font-semibold">x</p></div>',
      engine,
    );
    expect(r.tailwind).toBe(true);
    expect(r.classes).toEqual(expect.arrayContaining(['flex', 'gap-4', 'p-4', 'text-sm']));
  });

  it('classes definidas no <style> não contam como Tailwind', () => {
    const html = `<style>.hero{color:red}.card .title{font-weight:700}</style>
      <div class="hero"><div class="card"><h1 class="title">x</h1></div></div>`;
    const r = detectTailwind(html, engine);
    expect(r.tailwind).toBe(false);
    expect(r.total).toBe(0);
  });

  it('classes definidas no CSS externo também são excluídas', () => {
    const r = detectTailwind('<div class="card flex">x</div>', engine, '.card{padding:1rem}');
    expect(r.total).toBe(1);
    expect(r.tailwind).toBe(true);
  });

  it('maioria de classes próprias: não é Tailwind', () => {
    const r = detectTailwind('<div class="foo bar baz flex">x</div>', engine);
    expect(r.tailwind).toBe(false);
  });

  it('sem classes: não é Tailwind', () => {
    expect(detectTailwind('<div>oi</div>', engine).tailwind).toBe(false);
  });
});
