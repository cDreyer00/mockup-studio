import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from '../apply.js';
import { findNode, walk } from '../document.js';
import { History } from '../history.js';
import type { Op } from '../ops.js';
import { parseDocument } from '../schema.js';
import type { Document, Node } from '../types.js';
import { expandInstance, expandNodeTree, getComponent, isVirtualId } from './expand.js';
import {
  createComponentOps,
  detachInstanceOps,
  importKitOps,
  instanceNodeFor,
  pushOverridesToMainOps,
  resetInstanceOps,
} from './plan.js';

type Raw = Partial<Node> & { id: string };
const n = (id: string, type: Node['type'], tag: string, extra: Partial<Node> = {}): Raw => ({
  id,
  type,
  name: id,
  tag,
  attrs: {},
  style: {},
  children: [],
  locked: false,
  hidden: false,
  ...extra,
});

function fixture(): Document {
  return parseDocument({
    version: 1,
    id: 'doc_p',
    name: 'P',
    tokens: { '--color-primary': '#123456' },
    fonts: [],
    meta: { createdAt: 'x', updatedAt: 'x' },
    components: [
      {
        id: 'cp_btn',
        name: 'Button',
        props: [
          { name: 'variant', type: 'enum', default: 'default', options: ['default', 'outline'] },
          { name: 'label', type: 'string', default: 'OK' },
        ],
        root: n('el_btn', 'element', 'button', {
          style: { display: 'inline-flex' },
          children: [n('tx_lbl', 'text', 'span', { text: '{{label}}' })] as Node[],
        }),
        variants: [
          { when: { variant: 'outline' }, overrides: { tx_lbl: { style: { color: 'red' } } } },
        ],
      },
      {
        id: 'cp_box',
        name: 'Box',
        props: [{ name: 'body', type: 'slot' }],
        root: n('el_box', 'element', 'div', {
          children: [
            n('el_boxbody', 'element', 'div', {
              attrs: { 'data-slot': 'body' },
              children: [n('tx_boxdef', 'text', 'p', { text: 'vazio' })] as Node[],
            }),
            n('in_boxbtn', 'instance', 'button', { componentId: 'cp_btn' }),
          ] as Node[],
        }),
        variants: [],
      },
    ],
    pages: [
      {
        id: 'pg_1',
        name: 'P',
        background: '#fff',
        frames: [
          n('fr_1', 'frame', 'div', {
            position: { x: 0, y: 0 },
            style: { display: 'flex' },
            children: [
              n('el_hero', 'element', 'section', {
                name: 'Hero',
                position: { x: 5, y: 6 },
                hidden: false,
                locked: true,
                style: {
                  display: 'flex',
                  padding: '16px',
                  margin: '10px',
                  'flex-grow': '1',
                  position: 'relative',
                  background: 'var(--color-primary)',
                },
                states: { md: { 'margin-top': '4px', padding: '24px' } },
                children: [
                  n('tx_title', 'text', 'h1', { text: 'Olá', style: { color: 'white' } }),
                  n('el_link', 'element', 'a', {
                    attrs: { href: '/x' },
                    children: [n('tx_link', 'text', 'span', { text: 'Ir' }) as Node],
                  }),
                  n('el_area', 'element', 'div', {
                    attrs: { 'data-slot': 'body' },
                    children: [n('tx_area', 'text', 'p', { text: 'Área' })] as Node[],
                  }),
                  n('in_herobtn', 'instance', 'button', {
                    componentId: 'cp_btn',
                    props: { label: 'Vai' },
                  }),
                ] as Node[],
              }),
              n('in_b1', 'instance', 'button', {
                componentId: 'cp_btn',
                props: { variant: 'outline' },
                overrides: { tx_lbl: { text: 'Salvar', style: { 'font-weight': '700' } } },
              }),
              n('in_box1', 'instance', 'div', {
                componentId: 'cp_box',
                overrides: { 'in_boxbtn/tx_lbl': { text: 'Aninhado' } },
                children: [
                  n('el_bx', 'element', 'div', {
                    attrs: { 'data-slot': 'body' },
                    children: [n('tx_bx', 'text', 'p', { text: 'meu' })] as Node[],
                  }),
                ] as Node[],
              }),
            ] as Node[],
          }),
        ],
      },
    ],
  });
}

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

function node(doc: Document, id: string): Node {
  const p = findNode(doc, id);
  if (!p) throw new Error(`sem ${id}`);
  return p.node;
}

/** Forma visual (sem ids nem marcadores de instância), para comparar árvores. */
function shape(x: Node): unknown {
  return {
    type: x.type,
    name: x.name,
    tag: x.tag,
    attrs: x.attrs,
    style: x.style,
    text: x.text,
    states: x.states,
    classes: x.classes,
    hidden: x.hidden,
    children: x.children.map(shape),
  };
}

function roundTrip(doc: Document, ops: Op[]): Document {
  const h = new History(doc);
  const r = h.apply(ops);
  h.undo();
  expect(strip(h.doc)).toEqual(strip(doc));
  h.redo();
  expect(strip(h.doc)).toEqual(strip(r.doc));
  return r.doc;
}

describe('createComponentOps', () => {
  it('preserva o visual e move o posicionamento para a instância', () => {
    const doc = fixture();
    const original = expandNodeTree(doc, node(doc, 'el_hero'));
    const plan = createComponentOps(doc, 'el_hero', {
      componentId: 'cp_hero',
      instanceId: 'in_hero',
    });
    expect(plan.ops.map((o) => o.type)).toEqual(['replaceNode', 'addComponent']);
    const d1 = roundTrip(doc, plan.ops);
    const def = getComponent(d1, 'cp_hero')!;
    expect(def.name).toBe('Hero');
    expect(def.root.id).toBe('el_hero');
    expect(def.root.position).toBeUndefined();
    expect(def.root.locked).toBe(false);
    expect(def.root.style).toEqual({
      display: 'flex',
      padding: '16px',
      background: 'var(--color-primary)',
    });
    expect(def.root.states).toEqual({ md: { padding: '24px' } });
    // Prop inferida do data-slot.
    expect(def.props).toEqual([{ name: 'body', type: 'slot' }]);
    const inst = node(d1, 'in_hero');
    expect(inst.type).toBe('instance');
    expect(inst.position).toEqual({ x: 5, y: 6 });
    expect(inst.locked).toBe(true);
    expect(inst.style).toEqual({ margin: '10px', 'flex-grow': '1', position: 'relative' });
    expect(inst.states).toEqual({ md: { 'margin-top': '4px' } });
    expect(inst.children.map((c) => c.attrs['data-slot'])).toEqual(['body']);
    const expanded = expandInstance(d1, inst);
    expect(shape(expanded)).toEqual(shape(original));
    expect(expanded.position).toEqual({ x: 5, y: 6 });
  });

  it('bind troca o valor atual por {{nome}} e usa o valor como padrão', () => {
    const doc = fixture();
    const original = expandNodeTree(doc, node(doc, 'el_hero'));
    const plan = createComponentOps(doc, 'el_hero', {
      name: 'Hero',
      description: 'Topo',
      props: [
        { name: 'title', type: 'string', bind: { nodeId: 'tx_title', target: 'text' } },
        { name: 'href', type: 'string', bind: { nodeId: 'el_link', target: 'attr:href' } },
        { name: 'ink', type: 'color', bind: { nodeId: 'tx_title', target: 'style:color' } },
      ],
    });
    const d1 = applyOps(doc, plan.ops).doc;
    const def = getComponent(d1, plan.componentId)!;
    expect(def.description).toBe('Topo');
    expect(def.props.map((p) => [p.name, p.type, p.default])).toEqual([
      ['title', 'string', 'Olá'],
      ['href', 'string', '/x'],
      ['ink', 'color', 'white'],
      ['body', 'slot', undefined],
    ]);
    expect(def.root.children[0].text).toBe('{{title}}');
    expect(def.root.children[0].style.color).toBe('{{ink}}');
    expect(def.root.children[1].attrs.href).toBe('{{href}}');
    expect(shape(expandInstance(d1, node(d1, plan.instanceId)))).toEqual(shape(original));
  });

  it('props omitidas são inferidas de {{nome}} (string, padrão vazio)', () => {
    const doc = applyOp(fixture(), {
      type: 'setText',
      changes: [{ nodeId: 'tx_area', text: '{{sub}} e {{other}}' }],
    }).doc;
    const plan = createComponentOps(doc, 'el_hero', {
      props: [{ name: 'sub', type: 'string', default: 'Sub' }],
    });
    const def = applyOps(doc, plan.ops).doc.components!.find((c) => c.id === plan.componentId)!;
    expect(def.props).toEqual([
      { name: 'sub', type: 'string', default: 'Sub' },
      { name: 'body', type: 'slot' },
      { name: 'other', type: 'string', default: '' },
    ]);
  });

  it('nome único e recusas', () => {
    const doc = fixture();
    const plan = createComponentOps(doc, 'tx_title', { name: 'button' });
    const d1 = applyOps(doc, plan.ops).doc;
    expect(getComponent(d1, plan.componentId)!.name).toBe('button 2');
    expect(() => createComponentOps(doc, 'fr_1')).toThrow(/frame raiz/);
    expect(() => createComponentOps(doc, 'in_b1/tx_lbl')).toThrow(/interno/);
    expect(() => createComponentOps(doc, 'tx_lbl')).toThrow(/principal/);
    expect(() => createComponentOps(doc, 'in_b1')).toThrow(/já é uma instância/);
    expect(() =>
      createComponentOps(doc, 'el_hero', {
        props: [{ name: 'x', type: 'string', bind: { nodeId: 'tx_title', target: 'attr:alt' } }],
      }),
    ).toThrow(/atributo/);
  });
});

describe('instanceNodeFor', () => {
  it('contêineres para os slots, props validadas e padrões omitidos', () => {
    const doc = fixture();
    const box = instanceNodeFor(doc, 'Box', {
      id: 'in_new',
      slots: { body: [n('tx_q', 'text', 'p', { text: 'q' }) as Node] },
      style: { marginTop: '4px' },
    });
    expect(box.componentId).toBe('cp_box');
    expect(box.style).toEqual({ 'margin-top': '4px' });
    expect(box.children).toHaveLength(1);
    expect(box.children[0]).toMatchObject({
      type: 'element',
      tag: 'div',
      name: 'Slot body',
      attrs: { 'data-slot': 'body' },
    });
    const d1 = roundTrip(doc, [{ type: 'createNode', parentId: 'fr_1', node: box }]);
    expect(expandInstance(d1, node(d1, 'in_new')).children[0].children[0].id).toBe('tx_q');
    const btn = instanceNodeFor(doc, 'cp_btn', { props: { variant: 'default', label: 'Ir' } });
    expect(btn.props).toEqual({ label: 'Ir' });
    expect(btn.children).toEqual([]);
    expect(() => instanceNodeFor(doc, 'cp_btn', { props: { variant: 'x' } })).toThrow(/opções/);
    expect(() => instanceNodeFor(doc, 'cp_box', { slots: { foot: [] } })).toThrow(/slot "foot"/);
    expect(() => instanceNodeFor(doc, 'Nada')).toThrow(/não encontrado/);
  });
});

describe('detach, push e reset', () => {
  it('detachInstanceOps: árvore concreta com ids reais; slot mantém ids; aninhada continua instância', () => {
    const doc = fixture();
    const before = expandInstance(doc, node(doc, 'in_box1'));
    const ops = detachInstanceOps(doc, 'in_box1');
    const d1 = roundTrip(doc, ops);
    const out = d1.pages[0].frames[0].children[2];
    expect(out.type).toBe('element');
    expect(out.id).toMatch(/^el_[0-9a-z]{8}$/);
    expect(out.componentId).toBeUndefined();
    const ids: string[] = [];
    walk(out, (x) => void ids.push(x.id));
    expect(ids.some(isVirtualId)).toBe(false);
    expect(out.children[0].id).toBe('el_bx');
    expect(out.children[0].children[0].id).toBe('tx_bx');
    const nested = out.children[1];
    expect(nested.type).toBe('instance');
    expect(nested.id).toMatch(/^in_[0-9a-z]{8}$/);
    expect(nested.overrides).toEqual({ tx_lbl: { text: 'Aninhado' } });
    expect(shape(expandNodeTree(d1, out))).toEqual(shape(before));
    expect(() => detachInstanceOps(doc, 'in_box1/in_boxbtn')).toThrow(/interno/);
    expect(() => detachInstanceOps(doc, 'el_hero')).toThrow(/não é uma instância/);
  });

  it('pushOverridesToMainOps grava no principal e limpa a instância', () => {
    const doc = fixture();
    const ops = pushOverridesToMainOps(doc, 'in_b1');
    expect(ops.map((o) => o.type)).toEqual(['updateComponent', 'setInstanceOverrides']);
    const d1 = roundTrip(doc, ops);
    const root = getComponent(d1, 'cp_btn')!.root;
    expect(root.children[0].text).toBe('Salvar');
    expect(root.children[0].style['font-weight']).toBe('700');
    expect(node(d1, 'in_b1').overrides).toBeUndefined();
    // Override aninhado vai para a instância aninhada dentro do principal.
    const d2 = applyOps(doc, pushOverridesToMainOps(doc, 'in_box1')).doc;
    const inner = getComponent(d2, 'cp_box')!.root.children[1];
    expect(inner.overrides).toEqual({ tx_lbl: { text: 'Aninhado' } });
    expect(pushOverridesToMainOps(d2, 'in_box1')).toEqual([]);
  });

  it('resetInstanceOps remove os overrides', () => {
    const doc = fixture();
    const d1 = roundTrip(doc, resetInstanceOps(doc, 'in_b1'));
    expect(node(d1, 'in_b1').overrides).toBeUndefined();
    const d2 = applyOps(doc, resetInstanceOps(doc, 'in_box1/in_boxbtn')).doc;
    expect(node(d2, 'in_box1').overrides).toBeUndefined();
  });
});

describe('importKitOps', () => {
  const kit = parseDocument(
    readFileSync(new URL('../../../../kits/shadcn-like.mockup.json', import.meta.url), 'utf8'),
  );

  it('importa o kit real e é idempotente', () => {
    const doc = fixture();
    const plan = importKitOps(doc, kit, 'shadcn-like');
    expect(plan.components.every((c) => c.status === 'added')).toBe(true);
    expect(plan.components.map((c) => c.name)).toContain('Card');
    // Button do documento já existe com esse nome: o do kit ganha sufixo.
    expect(plan.components.find((c) => c.id === 'cp_sbutton1')!.name).toBe('Button 2');
    expect(plan.tokensAdded.length).toBeGreaterThan(0);
    expect(plan.tokensAdded).not.toContain('--color-primary');
    const d1 = roundTrip(doc, plan.ops);
    expect(d1.components!.filter((c) => c.kit === 'shadcn-like')).toHaveLength(
      kit.components!.length,
    );
    const dark = d1.themes!.find((t) => t.name === 'dark')!;
    expect(Object.keys(dark.overrides).length).toBeGreaterThan(0);
    expect(dark.overrides['--color-primary']).toBeUndefined();
    const again = importKitOps(d1, kit, 'shadcn-like');
    expect(again.ops).toEqual([]);
    expect(again.components.every((c) => c.status === 'unchanged')).toBe(true);
    // Mudança no principal: reimportar atualiza.
    const changed = applyOp(d1, {
      type: 'updateStyles',
      nodeIds: ['el_sbtnroot'],
      styles: { color: 'red' },
    }).doc;
    const upd = importKitOps(changed, kit, 'shadcn-like');
    expect(upd.components.find((c) => c.id === 'cp_sbutton1')!.status).toBe('updated');
    const d2 = applyOps(changed, upd.ops).doc;
    expect(importKitOps(d2, kit, 'shadcn-like').ops).toEqual([]);
  });

  it('ids de nós em colisão ganham ids derivados estáveis (chaves de variantes remapeadas)', () => {
    const doc = fixture();
    // Um nó da página com o id do rótulo do Button do kit.
    const withClash = applyOp(doc, {
      type: 'createNode',
      parentId: 'fr_1',
      node: n('tx_sbtnlabl', 'text', 'p', { text: 'colide' }) as Node,
    }).doc;
    const plan = importKitOps(withClash, kit, 'shadcn-like');
    const d1 = applyOps(withClash, plan.ops).doc;
    const btn = getComponent(d1, 'cp_sbutton1')!;
    const label = btn.root.children[0];
    expect(label.id).not.toBe('tx_sbtnlabl');
    expect(label.id).toMatch(/^tx_[0-9a-z]{8}$/);
    const kitBtn = kit.components!.find((c) => c.id === 'cp_sbutton1')!;
    const kitKeys = kitBtn.variants.flatMap((v) => Object.keys(v.overrides));
    const keys = btn.variants.flatMap((v) => Object.keys(v.overrides));
    expect(keys).toEqual(kitKeys.map((k) => (k === 'tx_sbtnlabl' ? label.id : k)));
    expect(importKitOps(d1, kit, 'shadcn-like').ops).toEqual([]);
  });
});
