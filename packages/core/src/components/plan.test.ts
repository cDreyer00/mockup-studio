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
              children: [n('tx_boxdef', 'text', 'p', { text: 'empty' })] as Node[],
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
                  n('tx_title', 'text', 'h1', { text: 'Hello', style: { color: 'white' } }),
                  n('el_link', 'element', 'a', {
                    attrs: { href: '/x' },
                    children: [n('tx_link', 'text', 'span', { text: 'Ir' }) as Node],
                  }),
                  n('el_area', 'element', 'div', {
                    attrs: { 'data-slot': 'body' },
                    children: [n('tx_area', 'text', 'p', { text: 'Area' })] as Node[],
                  }),
                  n('in_herobtn', 'instance', 'button', {
                    componentId: 'cp_btn',
                    props: { label: 'Go' },
                  }),
                ] as Node[],
              }),
              n('in_b1', 'instance', 'button', {
                componentId: 'cp_btn',
                props: { variant: 'outline' },
                overrides: { tx_lbl: { text: 'Save', style: { 'font-weight': '700' } } },
              }),
              n('in_box1', 'instance', 'div', {
                componentId: 'cp_box',
                overrides: { 'in_boxbtn/tx_lbl': { text: 'Nested' } },
                children: [
                  n('el_bx', 'element', 'div', {
                    attrs: { 'data-slot': 'body' },
                    children: [n('tx_bx', 'text', 'p', { text: 'mine' })] as Node[],
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
  if (!p) throw new Error(`no ${id}`);
  return p.node;
}

/** Visual shape (without ids or instance markers), for comparing trees. */
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
  it('preserves the visuals and moves the positioning to the instance', () => {
    const doc = fixture();
    const original = expandNodeTree(doc, node(doc, 'el_hero'));
    const plan = createComponentOps(doc, 'el_hero', {
      componentId: 'cp_hero',
      instanceId: 'in_hero',
    });
    expect(plan.ops.map((o) => o.type)).toEqual(['replaceNode', 'addComponent', 'replaceNode']);
    const d1 = roundTrip(doc, plan.ops);
    // Undo removes the main component without `force` (the provisional node takes the instance out first).
    const h = new History(doc);
    const { inverse } = h.apply(plan.ops);
    expect(inverse.find((o) => o.type === 'deleteComponent')).toEqual({
      type: 'deleteComponent',
      componentId: 'cp_hero',
    });
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
    // Prop inferred from data-slot.
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

  it('bind replaces the current value with {{name}} and uses the value as the default', () => {
    const doc = fixture();
    const original = expandNodeTree(doc, node(doc, 'el_hero'));
    const plan = createComponentOps(doc, 'el_hero', {
      name: 'Hero',
      description: 'Top',
      props: [
        { name: 'title', type: 'string', bind: { nodeId: 'tx_title', target: 'text' } },
        { name: 'href', type: 'string', bind: { nodeId: 'el_link', target: 'attr:href' } },
        { name: 'ink', type: 'color', bind: { nodeId: 'tx_title', target: 'style:color' } },
      ],
    });
    const d1 = applyOps(doc, plan.ops).doc;
    const def = getComponent(d1, plan.componentId)!;
    expect(def.description).toBe('Top');
    expect(def.props.map((p) => [p.name, p.type, p.default])).toEqual([
      ['title', 'string', 'Hello'],
      ['href', 'string', '/x'],
      ['ink', 'color', 'white'],
      ['body', 'slot', undefined],
    ]);
    expect(def.root.children[0].text).toBe('{{title}}');
    expect(def.root.children[0].style.color).toBe('{{ink}}');
    expect(def.root.children[1].attrs.href).toBe('{{href}}');
    expect(shape(expandInstance(d1, node(d1, plan.instanceId)))).toEqual(shape(original));
  });

  it('omitted props are inferred from {{name}} (string, empty default)', () => {
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

  it('unique name and rejections', () => {
    const doc = fixture();
    const plan = createComponentOps(doc, 'tx_title', { name: 'button' });
    const d1 = applyOps(doc, plan.ops).doc;
    expect(getComponent(d1, plan.componentId)!.name).toBe('button 2');
    expect(() => createComponentOps(doc, 'fr_1')).toThrow(/root frame/);
    expect(() => createComponentOps(doc, 'in_b1/tx_lbl')).toThrow(/internal/);
    expect(() => createComponentOps(doc, 'tx_lbl')).toThrow(/main component/);
    expect(() => createComponentOps(doc, 'in_b1')).toThrow(/already a component instance/);
    expect(() =>
      createComponentOps(doc, 'el_hero', {
        props: [{ name: 'x', type: 'string', bind: { nodeId: 'tx_title', target: 'attr:alt' } }],
      }),
    ).toThrow(/attribute/);
  });
});

describe('instanceNodeFor', () => {
  it('containers for the slots, validated props and omitted defaults', () => {
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
    expect(() => instanceNodeFor(doc, 'cp_btn', { props: { variant: 'x' } })).toThrow(/options/);
    expect(() => instanceNodeFor(doc, 'cp_box', { slots: { foot: [] } })).toThrow(/slot "foot"/);
    expect(() => instanceNodeFor(doc, 'Nothing')).toThrow(/not found/);
  });
});

describe('detach, push and reset', () => {
  it('detachInstanceOps: concrete tree with real ids; slot keeps ids; nested one stays an instance', () => {
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
    expect(nested.overrides).toEqual({ tx_lbl: { text: 'Nested' } });
    expect(shape(expandNodeTree(d1, out))).toEqual(shape(before));
    expect(() => detachInstanceOps(doc, 'in_box1/in_boxbtn')).toThrow(/internal/);
    expect(() => detachInstanceOps(doc, 'el_hero')).toThrow(/is not a component instance/);
  });

  it('pushOverridesToMainOps writes to the main component and clears the instance', () => {
    const doc = fixture();
    const ops = pushOverridesToMainOps(doc, 'in_b1');
    expect(ops.map((o) => o.type)).toEqual(['updateComponent', 'setInstanceOverrides']);
    const d1 = roundTrip(doc, ops);
    const root = getComponent(d1, 'cp_btn')!.root;
    expect(root.children[0].text).toBe('Save');
    expect(root.children[0].style['font-weight']).toBe('700');
    expect(node(d1, 'in_b1').overrides).toBeUndefined();
    // A nested override goes to the nested instance inside the main component.
    const d2 = applyOps(doc, pushOverridesToMainOps(doc, 'in_box1')).doc;
    const inner = getComponent(d2, 'cp_box')!.root.children[1];
    expect(inner.overrides).toEqual({ tx_lbl: { text: 'Nested' } });
    expect(pushOverridesToMainOps(d2, 'in_box1')).toEqual([]);
  });

  it('resetInstanceOps removes the overrides', () => {
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

  it('imports the real kit and is idempotent', () => {
    const doc = fixture();
    const plan = importKitOps(doc, kit, 'shadcn-like');
    expect(plan.components.every((c) => c.status === 'added')).toBe(true);
    expect(plan.components.map((c) => c.name)).toContain('Card');
    // The document's Button already has that name: the kit's gets a suffix.
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
    // Change in the main component: reimporting updates it.
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

  it('onlyMissing: reinserting a deleted component does not undo edits to the other main components', () => {
    const doc = fixture();
    const d1 = applyOps(doc, importKitOps(doc, kit, 'shadcn-like').ops).doc;
    // Edits the Button and deletes the List (no instances).
    const edited = applyOps(d1, [
      { type: 'updateStyles', nodeIds: ['el_sbtnroot'], styles: { color: 'red' } },
      { type: 'deleteComponent', componentId: 'cp_slist001' },
    ]).doc;
    expect(getComponent(edited, 'cp_slist001')).toBeUndefined();
    const plan = importKitOps(edited, kit, 'shadcn-like', { onlyMissing: true });
    expect(plan.ops.map((o) => o.type)).toEqual(['addComponent']);
    const status = Object.fromEntries(plan.components.map((c) => [c.id, c.status]));
    expect(status.cp_slist001).toBe('added');
    expect(status.cp_sbutton1).toBe('diverged');
    expect(status.cp_scard001).toBe('unchanged');
    const d2 = applyOps(edited, plan.ops).doc;
    expect(getComponent(d2, 'cp_sbutton1')!.root.style.color).toBe('red');
    expect(getComponent(d2, 'cp_slist001')!.kit).toBe('shadcn-like');
    // Without onlyMissing (overwrite) the Button goes back to the kit's.
    const over = importKitOps(d2, kit, 'shadcn-like');
    expect(over.components.find((c) => c.id === 'cp_sbutton1')!.status).toBe('updated');
    expect(
      applyOps(d2, over.ops).doc.components!.find((c) => c.id === 'cp_sbutton1')!.root.style.color,
    ).not.toBe('red');
  });

  it('onlyMissing: renaming does not count as missing (the kit id is what matters)', () => {
    const doc = fixture();
    const d1 = applyOps(doc, importKitOps(doc, kit, 'shadcn-like').ops).doc;
    // Renames and edits the kit's Button and deletes the Dialog (which uses the Button).
    const renamed = applyOps(d1, [
      { type: 'updateComponent', componentId: 'cp_sbutton1', name: 'PrimaryBtn' },
      { type: 'updateStyles', nodeIds: ['el_sbtnroot'], styles: { color: 'red' } },
      { type: 'deleteComponent', componentId: 'cp_sdialog1' },
    ]).doc;
    // Inserting the Dialog again (as insert_component does) only brings the Dialog.
    const plan = importKitOps(renamed, kit, 'shadcn-like', { onlyMissing: true });
    expect(plan.ops.map((o) => o.type)).toEqual(['addComponent']);
    expect(plan.components.find((c) => c.id === 'cp_sdialog1')!.status).toBe('added');
    expect(plan.components.find((c) => c.id === 'cp_sbutton1')).toEqual({
      id: 'cp_sbutton1',
      name: 'PrimaryBtn',
      status: 'diverged',
    });
    const d2 = applyOps(renamed, plan.ops).doc;
    const btn = getComponent(d2, 'cp_sbutton1')!;
    expect(btn.name).toBe('PrimaryBtn');
    expect(btn.root.style.color).toBe('red');
    expect(d2.components!.filter((c) => c.name.startsWith('Button'))).toHaveLength(1); // the fixture's
    // The Button instance inside the reimported Dialog points to the renamed Button.
    const dlg = getComponent(d2, 'cp_sdialog1')!;
    const nested: string[] = [];
    walk(dlg.root, (x) => {
      if (x.type === 'instance') nested.push(x.componentId!);
    });
    expect(nested).toContain('cp_sbutton1');
  });

  it('components with the kit id but another origin are never touched', () => {
    const doc = fixture();
    const d1 = applyOps(doc, importKitOps(doc, kit, 'shadcn-like').ops).doc;
    const foreign = applyOps(d1, [
      { type: 'updateComponent', componentId: 'cp_sinput01', kit: null },
      { type: 'updateStyles', nodeIds: ['el_sinproot'], styles: { color: 'red' } },
    ]).doc;
    for (const onlyMissing of [false, true]) {
      const plan = importKitOps(foreign, kit, 'shadcn-like', { onlyMissing });
      expect(plan.ops).toEqual([]);
      expect(plan.skipped.map((c) => c.id)).toEqual(['cp_sinput01']);
      expect(plan.components.some((c) => c.id === 'cp_sinput01')).toBe(false);
    }
  });

  it('colliding node ids get stable derived ids (variant keys remapped)', () => {
    const doc = fixture();
    // A page node with the id of the kit Button's label.
    const withClash = applyOp(doc, {
      type: 'createNode',
      parentId: 'fr_1',
      node: n('tx_sbtnlabl', 'text', 'p', { text: 'collides' }) as Node,
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
