import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from '../apply.js';
import { findNode } from '../document.js';
import { History } from '../history.js';
import type { Op } from '../ops.js';
import { assertPublicOps } from '../ops.schema.js';
import { parseDocument } from '../schema.js';
import { getTreeSummary } from '../summary.js';
import type { ComponentDef, Document, Node } from '../types.js';
import { expandInstance, getComponent } from './expand.js';
import { routeComponentOp } from './route.js';

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
    id: 'doc_t',
    name: 'T',
    tokens: { '--c': '#111' },
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
          style: { display: 'inline-flex', background: 'var(--c)' },
          children: [n('tx_lbl', 'text', 'span', { text: '{{label}}' })] as Node[],
        }),
        variants: [
          {
            when: { variant: 'outline' },
            overrides: { '': { style: { border: '1px solid var(--c)' } } },
          },
        ],
      },
      {
        id: 'cp_card',
        name: 'Card',
        props: [
          { name: 'title', type: 'string', default: 'Title' },
          { name: 'content', type: 'slot' },
        ],
        root: n('el_card', 'element', 'div', {
          children: [
            n('tx_ttl', 'text', 'h3', { text: '{{title}}' }),
            n('el_body', 'element', 'div', {
              attrs: { 'data-slot': 'content' },
              children: [n('tx_def', 'text', 'p', { text: 'Default' })] as Node[],
            }),
            n('in_cbtn', 'instance', 'button', {
              componentId: 'cp_btn',
              props: { label: 'Action' },
            }),
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
            children: [
              n('in_b1', 'instance', 'button', {
                componentId: 'cp_btn',
                props: { variant: 'outline', label: 'Save' },
              }),
              n('in_c1', 'instance', 'div', {
                componentId: 'cp_card',
                children: [
                  n('el_s1', 'element', 'div', {
                    attrs: { 'data-slot': 'content' },
                    children: [n('tx_s1', 'text', 'p', { text: 'My' })] as Node[],
                  }),
                ] as Node[],
              }),
              n('in_c2', 'instance', 'div', { componentId: 'cp_card' }),
              n('el_plain', 'element', 'div', { style: { color: 'var(--c)' } }),
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

function comp(doc: Document, id: string): ComponentDef {
  return getComponent(doc, id)!;
}

/** Applies through History and checks for an exact undo and an identical redo. */
function roundTrip(doc: Document, ops: Op[]): Document {
  const h = new History(doc);
  const r = h.apply(ops);
  const after = strip(r.doc);
  h.undo();
  expect(strip(h.doc)).toEqual(strip(doc));
  h.redo();
  expect(strip(h.doc)).toEqual(after);
  return r.doc;
}

const button = (): ComponentDef => ({
  id: 'cp_new',
  name: 'Badge',
  props: [{ name: 'text', type: 'string', default: 'New' }],
  root: n('el_badge', 'element', 'span', {
    children: [n('tx_badge', 'text', 'span', { text: '{{text}}' })] as Node[],
  }) as Node,
  variants: [],
});

describe('primitive component ops', () => {
  it('addComponent / deleteComponent with undo and redo', () => {
    const doc = fixture();
    const d1 = roundTrip(doc, [{ type: 'addComponent', component: button(), index: 1 }]);
    expect(d1.components!.map((c) => c.id)).toEqual(['cp_btn', 'cp_new', 'cp_card']);
    const r = applyOp(d1, { type: 'deleteComponent', componentId: 'cp_new' });
    expect(r.inverse).toEqual([{ type: 'addComponent', component: comp(d1, 'cp_new'), index: 1 }]);
    roundTrip(d1, [{ type: 'deleteComponent', componentId: 'cp_new' }]);
  });

  it('addComponent validates name, root, ids and cycles', () => {
    const doc = fixture();
    expect(() =>
      applyOp(doc, { type: 'addComponent', component: { ...button(), name: 'button' } }),
    ).toThrow(/named/);
    expect(() =>
      applyOp(doc, {
        type: 'addComponent',
        component: { ...button(), root: { ...button().root, type: 'frame' } },
      }),
    ).toThrow(/frame/);
    // Node id from a page and from another main component.
    const dupPage = { ...button(), root: { ...button().root, id: 'el_plain' } };
    expect(() => applyOp(doc, { type: 'addComponent', component: dupPage })).toThrow(/el_plain/);
    const dupComp = { ...button(), root: { ...button().root, id: 'tx_lbl' } };
    expect(() => applyOp(doc, { type: 'addComponent', component: dupComp })).toThrow(/tx_lbl/);
    // The root position is discarded.
    const r = applyOp(doc, {
      type: 'addComponent',
      component: { ...button(), root: { ...button().root, position: { x: 1, y: 1 } } },
    });
    expect(comp(r.doc, 'cp_new').root.position).toBeUndefined();
  });

  it('createNode/duplicate do not reuse component root ids', () => {
    const doc = fixture();
    expect(() =>
      applyOp(doc, {
        type: 'createNode',
        parentId: 'fr_1',
        node: n('tx_lbl', 'text', 'p', { text: 'x' }) as Node,
      }),
    ).toThrow(/tx_lbl/);
  });

  it('deleteComponent refuses when instances exist (unless force, internal to undo)', () => {
    const doc = fixture();
    expect(() => applyOp(doc, { type: 'deleteComponent', componentId: 'cp_btn' })).toThrow(
      /instances/,
    );
    const r = applyOp(doc, { type: 'deleteComponent', componentId: 'cp_card', force: true });
    expect(r.doc.components!.map((c) => c.id)).toEqual(['cp_btn']);
    const warnings: string[] = [];
    expandInstance(r.doc, node(r.doc, 'in_c1'), { warnings });
    expect(warnings).toHaveLength(1);
  });

  it('addComponent inverse: without force, unless instances of that id already existed', () => {
    const doc = fixture();
    const fresh = { ...button(), id: 'cp_new', name: 'New' };
    fresh.root = n('el_new1', 'element', 'button') as Node;
    expect(applyOp(doc, { type: 'addComponent', component: fresh }).inverse).toEqual([
      { type: 'deleteComponent', componentId: 'cp_new' },
    ]);
    // Orphan instance (component does not exist yet): undo leaves it orphaned again.
    const orphan = applyOp(doc, {
      type: 'createNode',
      parentId: 'fr_1',
      node: n('in_orf', 'instance', 'button', { componentId: 'cp_new' }) as Node,
    }).doc;
    const added = applyOp(orphan, { type: 'addComponent', component: fresh });
    expect(added.inverse).toEqual([
      { type: 'deleteComponent', componentId: 'cp_new', force: true },
    ]);
    const h = new History(orphan);
    h.apply([{ type: 'addComponent', component: fresh }]);
    h.undo();
    expect(strip(h.doc)).toEqual(strip(orphan));
  });

  it('force coming from outside is rejected (assertPublicOps)', () => {
    expect(() =>
      assertPublicOps([{ type: 'deleteComponent', componentId: 'cp_card', force: true }]),
    ).toThrow(/"force" in deleteComponent is internal/);
    expect(() =>
      assertPublicOps([{ type: 'deleteComponent', componentId: 'cp_card', force: false }]),
    ).toThrow(/internal/);
    expect(() =>
      assertPublicOps([{ type: 'deleteComponent', componentId: 'cp_card' }]),
    ).not.toThrow();
  });

  it('updateComponent with exact inverse and validations', () => {
    const doc = fixture();
    const root = structuredClone(comp(doc, 'cp_btn').root);
    root.style.color = 'red';
    const d1 = roundTrip(doc, [
      {
        type: 'updateComponent',
        componentId: 'cp_btn',
        name: 'Button label',
        description: 'desc',
        props: [
          ...comp(doc, 'cp_btn').props,
          { name: 'size', type: 'enum', options: ['sm', 'lg'] },
        ],
        variants: [],
        root,
      },
    ]);
    const c = comp(d1, 'cp_btn');
    expect(c.name).toBe('Button label');
    expect(c.description).toBe('desc');
    expect(c.variants).toEqual([]);
    expect(expandInstance(d1, node(d1, 'in_b1')).style.color).toBe('red');
    const r = applyOp(d1, { type: 'updateComponent', componentId: 'cp_btn', description: null });
    expect(comp(r.doc, 'cp_btn').description).toBeUndefined();
    expect(() =>
      applyOp(doc, { type: 'updateComponent', componentId: 'cp_btn', name: 'Card' }),
    ).toThrow(/named/);
    // Cycle: Button now contains a Card (which contains Button).
    const loop = structuredClone(comp(doc, 'cp_btn').root);
    loop.children.push(n('in_loop', 'instance', 'div', { componentId: 'cp_card' }) as Node);
    expect(() =>
      applyOp(doc, { type: 'updateComponent', componentId: 'cp_btn', root: loop }),
    ).toThrow(/cycle/);
  });

  it('replaceNode swaps in place and undoes', () => {
    const doc = fixture();
    const d1 = roundTrip(doc, [
      { type: 'replaceNode', nodeId: 'el_plain', node: n('el_new', 'element', 'section') as Node },
    ]);
    expect(d1.pages[0].frames[0].children[3].id).toBe('el_new');
    // Reusing the swapped node's ids is allowed; ids of other nodes are not.
    expect(() =>
      applyOp(doc, {
        type: 'replaceNode',
        nodeId: 'el_plain',
        node: n('tx_s1', 'text', 'p') as Node,
      }),
    ).toThrow(/tx_s1/);
    applyOp(doc, {
      type: 'replaceNode',
      nodeId: 'el_plain',
      node: n('el_plain', 'element', 'p') as Node,
    });
  });

  it('setInstanceProps: set/unset, type validation and undo', () => {
    const doc = fixture();
    const d1 = roundTrip(doc, [
      {
        type: 'setInstanceProps',
        changes: [{ nodeId: 'in_b1', set: { label: 'Ir' }, unset: ['variant'] }],
      },
    ]);
    expect(node(d1, 'in_b1').props).toEqual({ label: 'Ir' });
    const d2 = applyOp(d1, {
      type: 'setInstanceProps',
      changes: [{ nodeId: 'in_b1', unset: ['label'] }],
    }).doc;
    expect(node(d2, 'in_b1').props).toBeUndefined();
    const bad = (set: Record<string, string | number | boolean>, re: RegExp): void => {
      expect(() =>
        applyOp(doc, { type: 'setInstanceProps', changes: [{ nodeId: 'in_b1', set }] }),
      ).toThrow(re);
    };
    bad({ variant: 'ghost' }, /options/);
    bad({ nope: 'x' }, /has no prop/);
    expect(() =>
      applyOp(doc, {
        type: 'setInstanceProps',
        changes: [{ nodeId: 'in_c1', set: { content: 'x' } }],
      }),
    ).toThrow(/slot/);
    expect(() =>
      applyOp(doc, {
        type: 'setInstanceProps',
        changes: [{ nodeId: 'el_plain', set: { a: 'x' } }],
      }),
    ).toThrow(/is not a component instance/);
  });

  it('setInstanceOverrides: replaces the map, validates and undoes', () => {
    const doc = fixture();
    const d1 = roundTrip(doc, [
      {
        type: 'setInstanceOverrides',
        changes: [
          {
            nodeId: 'in_b1',
            overrides: { tx_lbl: { text: 'X', style: { fontWeight: '700' } }, el_x: {} },
          },
        ],
      },
    ]);
    expect(node(d1, 'in_b1').overrides).toEqual({
      tx_lbl: { text: 'X', style: { 'font-weight': '700' } },
    });
    const d2 = roundTrip(d1, [
      { type: 'setInstanceOverrides', changes: [{ nodeId: 'in_b1', overrides: null }] },
    ]);
    expect(node(d2, 'in_b1').overrides).toBeUndefined();
    expect(() =>
      applyOp(doc, {
        type: 'setInstanceOverrides',
        changes: [{ nodeId: 'in_b1', overrides: { tx_lbl: { style: { color: 'red; } x {' } } } }],
      }),
    ).toThrow(/[Ii]nvalid/);
    expect(() =>
      applyOp(doc, {
        type: 'setInstanceOverrides',
        changes: [{ nodeId: 'in_b1', overrides: { tx_lbl: { attrs: { onclick: 'x' } } } }],
      }),
    ).toThrow(/on\*/);
  });

  it('an instance only accepts slot containers as children', () => {
    const doc = fixture();
    expect(() =>
      applyOp(doc, {
        type: 'createNode',
        parentId: 'in_c2',
        node: n('tx_x', 'text', 'p', { text: 'x' }) as Node,
      }),
    ).toThrow(/insert inside a slot/);
    expect(() =>
      applyOp(doc, {
        type: 'createNode',
        parentId: 'in_c1',
        node: n('el_x', 'element', 'div', { attrs: { 'data-slot': 'content' } }) as Node,
      }),
    ).toThrow(/already has a container/);
    expect(() =>
      applyOp(doc, {
        type: 'createNode',
        parentId: 'in_c2',
        node: n('el_x', 'element', 'div', { attrs: { 'data-slot': 'footer' } }) as Node,
      }),
    ).toThrow(/content/);
    roundTrip(doc, [
      {
        type: 'createNode',
        parentId: 'in_c2',
        node: n('el_x', 'element', 'div', { attrs: { 'data-slot': 'content' } }) as Node,
      },
    ]);
    expect(() =>
      applyOp(doc, { type: 'moveNodes', nodeIds: ['el_plain'], parentId: 'in_c2' }),
    ).toThrow(/insert inside a slot/);
    expect(() => applyOp(doc, { type: 'duplicateNodes', nodeIds: ['el_s1'] })).toThrow(/slot/);
    // New instance with an invalid child.
    expect(() =>
      applyOp(doc, {
        type: 'createNode',
        parentId: 'fr_1',
        node: n('in_z', 'instance', 'div', {
          componentId: 'cp_card',
          children: [n('tx_z', 'text', 'p') as Node],
        }) as Node,
      }),
    ).toThrow(/slot/);
    // Deleting and undoing the container puts it back on the instance.
    roundTrip(doc, [{ type: 'deleteNodes', nodeIds: ['el_s1'] }]);
  });

  it('renameToken updates roots, variants and overrides (with inverse)', () => {
    const base = fixture();
    const doc = applyOp(base, {
      type: 'setInstanceOverrides',
      changes: [{ nodeId: 'in_c2', overrides: { tx_ttl: { style: { color: 'var(--c)' } } } }],
    }).doc;
    const h = new History(doc);
    const r = h.apply([{ type: 'renameToken', from: '--c', to: '--brand' }]);
    const d1 = r.doc;
    expect(comp(d1, 'cp_btn').root.style.background).toBe('var(--brand)');
    expect(comp(d1, 'cp_btn').variants[0].overrides[''].style!.border).toBe(
      '1px solid var(--brand)',
    );
    expect(node(d1, 'in_c2').overrides!.tx_ttl.style!.color).toBe('var(--brand)');
    expect(node(d1, 'el_plain').style.color).toBe('var(--brand)');
    expect(r.results[0]).toMatchObject({ references: 4 });
    h.undo();
    expect(strip(h.doc)).toEqual(strip(doc));
    h.redo();
    expect(strip(h.doc)).toEqual(strip(d1));
  });

  it('document without components: regular ops behave unchanged', () => {
    const doc = fixture();
    delete doc.components;
    const r = applyOp(doc, {
      type: 'updateStyles',
      nodeIds: ['el_plain'],
      styles: { color: 'red' },
    });
    expect(node(r.doc, 'el_plain').style.color).toBe('red');
    expect(r.doc.components).toBeUndefined();
  });

  it('summary shows the instance with the component name and props', () => {
    const doc = fixture();
    const line = getTreeSummary(node(doc, 'in_b1'), 0, { doc });
    expect(line).toContain('◆Button variant=outline label="Save"');
  });
});

describe('routing', () => {
  it('an op the router does not know on an instance or main component node fails with a clear message', () => {
    const doc = fixture();
    // New op (e.g. vectors/grid) already in OpSchema but missing from targetIds: applyOp calls the
    // router before the handler, so the test calls the router directly with a fictitious op.
    const fake = (nodeId: string): Op =>
      ({ type: 'setGridFoo', changes: [{ nodeId, value: 1 }] }) as unknown as Op;
    const route = (op: Op) => routeComponentOp(doc, op, applyOp);
    expect(() => route(fake('in_b1/tx_lbl'))).toThrow(
      'Operation "setGridFoo" is not supported on instance nodes; use set_instance_override or detach the instance (detach_instance)',
    );
    expect(() =>
      route({ type: 'setGridFoo', nodeIds: ['in_c2/in_cbtn'] } as unknown as Op),
    ).toThrow(/is not supported on instance nodes/);
    expect(() => route(fake('tx_lbl'))).toThrow(
      /Operation "setGridFoo" is not supported on main component nodes/,
    );
    // Page node (or op with no node target): normal applyOp path.
    expect(route(fake('el_plain'))).toBeNull();
    expect(route({ type: 'setGridFoo', value: 1 } as unknown as Op)).toBeNull();
  });

  it('updateStyles on a virtual id becomes an override on the owning instance', () => {
    const doc = fixture();
    const d1 = roundTrip(doc, [
      { type: 'updateStyles', changes: [{ nodeId: 'in_b1/tx_lbl', set: { color: 'red' } }] },
    ]);
    expect(node(d1, 'in_b1').overrides).toEqual({ tx_lbl: { style: { color: 'red' } } });
    expect(expandInstance(d1, node(d1, 'in_b1')).children[0].style.color).toBe('red');
    // unset removes from the main component (unsetStyle).
    const d2 = applyOp(d1, {
      type: 'updateStyles',
      nodeIds: ['in_b1/tx_lbl'],
      unset: ['color'],
    }).doc;
    expect(node(d2, 'in_b1').overrides).toEqual({ tx_lbl: { unsetStyle: ['color'] } });
  });

  it('setText, setNodeFlags, setAttrs, setClasses, setStates and props on virtual ids', () => {
    const doc = fixture();
    const d1 = roundTrip(doc, [
      { type: 'setText', changes: [{ nodeId: 'in_c2/in_cbtn/tx_lbl', text: 'Y' }] },
      { type: 'setNodeFlags', changes: [{ nodeId: 'in_c2/tx_def', hidden: true }] },
      { type: 'setAttrs', changes: [{ nodeId: 'in_c2/tx_ttl', set: { title: 'tip' } }] },
      { type: 'setClasses', changes: [{ nodeId: 'in_c2/tx_ttl', classes: 'font-bold' }] },
      {
        type: 'setStates',
        changes: [{ nodeId: 'in_c2/tx_ttl', states: { hover: { color: 'red' } } }],
      },
      {
        type: 'setInstanceProps',
        changes: [{ nodeId: 'in_c2/in_cbtn', set: { variant: 'outline' } }],
      },
    ]);
    expect(node(d1, 'in_c2').overrides).toEqual({
      'in_cbtn/tx_lbl': { text: 'Y' },
      tx_def: { hidden: true },
      tx_ttl: {
        attrs: { title: 'tip' },
        classes: 'font-bold',
        states: { hover: { color: 'red' } },
      },
      in_cbtn: { props: { variant: 'outline' } },
    });
    const out = expandInstance(d1, node(d1, 'in_c2'));
    expect(out.children[2].children[0].text).toBe('Y');
    expect(out.children[2].style.border).toBe('1px solid var(--c)');
    expect(out.children[1].children[0].hidden).toBe(true);
    expect(() =>
      applyOp(doc, {
        type: 'setInstanceProps',
        changes: [{ nodeId: 'in_c2/in_cbtn', set: { variant: 'x' } }],
      }),
    ).toThrow(/options/);
  });

  it('setInstanceOverrides on a nested instance (virtual id) replaces the keys with the prefix', () => {
    const doc = applyOp(fixture(), {
      type: 'setInstanceOverrides',
      changes: [
        { nodeId: 'in_c2', overrides: { 'in_cbtn/tx_lbl': { text: 'A' }, tx_ttl: { text: 'T' } } },
      ],
    }).doc;
    const d1 = roundTrip(doc, [
      {
        type: 'setInstanceOverrides',
        changes: [{ nodeId: 'in_c2/in_cbtn', overrides: { '': { style: { gap: '1px' } } } }],
      },
    ]);
    expect(node(d1, 'in_c2').overrides).toEqual({
      tx_ttl: { text: 'T' },
      'in_cbtn/el_btn': { style: { gap: '1px' } },
    });
    expect(expandInstance(d1, node(d1, 'in_c2')).children[2].style.gap).toBe('1px');
  });

  it('virtual id without components in the document: a missing instance is rejected', () => {
    const doc = fixture();
    delete doc.components;
    expect(() =>
      applyOp(doc, { type: 'setText', changes: [{ nodeId: 'in_b1/tx_lbl', text: 'x' }] }),
    ).toThrow(/does not exist/);
  });

  it('structure edits on a virtual id are rejected', () => {
    const doc = fixture();
    const msg = /edit the main component or detach/;
    expect(() => applyOp(doc, { type: 'deleteNodes', nodeIds: ['in_c2/tx_ttl'] })).toThrow(msg);
    expect(() =>
      applyOp(doc, { type: 'moveNodes', nodeIds: ['in_c2/tx_ttl'], parentId: 'fr_1' }),
    ).toThrow(msg);
    expect(() => applyOp(doc, { type: 'duplicateNodes', nodeIds: ['in_c2/tx_ttl'] })).toThrow(msg);
    expect(() =>
      applyOp(doc, { type: 'setTag', changes: [{ nodeId: 'in_c2/tx_ttl', tag: 'h1' }] }),
    ).toThrow(msg);
    expect(() =>
      applyOp(doc, {
        type: 'createNode',
        parentId: 'in_c2/tx_ttl',
        node: n('tx_q', 'text', 'p') as Node,
      }),
    ).toThrow(/insert inside a slot/);
    expect(() =>
      applyOp(doc, { type: 'setText', changes: [{ nodeId: 'in_c2/el_nope', text: 'x' }] }),
    ).toThrow(/not found/);
  });

  it('createNode/moveNodes into a virtual slot container create the real container', () => {
    const doc = fixture();
    const op: Op = {
      type: 'createNode',
      parentId: 'in_c2/el_body',
      node: n('tx_new', 'text', 'p', { text: 'new' }) as Node,
    };
    const h = new History(doc);
    const r = h.apply([op]);
    const container = node(r.doc, 'in_c2').children[0];
    expect(container.id).toMatch(/^el_[0-9a-z]{8}$/);
    expect(container.attrs).toEqual({ 'data-slot': 'content' });
    expect(container.name).toBe('Slot content');
    expect(container.children.map((c) => c.id)).toEqual(['tx_new']);
    expect(r.results[0]).toMatchObject({ nodeIds: ['tx_new'], slotContainerId: container.id });
    const body = expandInstance(r.doc, node(r.doc, 'in_c2')).children[1];
    expect(body.id).toBe(container.id);
    expect(body.children[0].id).toBe('tx_new');
    h.undo();
    expect(strip(h.doc)).toEqual(strip(doc));
    h.redo();
    expect(strip(h.doc)).toEqual(strip(r.doc));
    // Deterministic: applying again on the same state gives the same id.
    expect(node(applyOp(doc, op).doc, 'in_c2').children[0].id).toBe(container.id);

    const m = roundTrip(doc, [
      { type: 'moveNodes', nodeIds: ['el_plain'], parentId: 'in_c2/el_body' },
    ]);
    expect(node(m, 'in_c2').children[0].children.map((c) => c.id)).toEqual(['el_plain']);
  });

  it('an op on a main component node becomes updateComponent', () => {
    const doc = fixture();
    const r = applyOp(doc, { type: 'updateStyles', nodeIds: ['tx_lbl'], styles: { color: 'red' } });
    expect(r.inverse[0].type).toBe('updateComponent');
    expect(findInRoot(comp(r.doc, 'cp_btn').root, 'tx_lbl')!.style.color).toBe('red');
    // All instances (including nested ones) reflect it.
    expect(expandInstance(r.doc, node(r.doc, 'in_b1')).children[0].style.color).toBe('red');
    expect(expandInstance(r.doc, node(r.doc, 'in_c1')).children[2].children[0].style.color).toBe(
      'red',
    );
    roundTrip(doc, [
      { type: 'updateStyles', nodeIds: ['tx_lbl'], styles: { color: 'red' } },
      {
        type: 'createNode',
        parentId: 'el_card',
        node: n('tx_more', 'text', 'p', { text: '+' }) as Node,
        index: 1,
      },
      { type: 'setText', changes: [{ nodeId: 'tx_def', text: 'Empty' }] },
      { type: 'moveNodes', nodeIds: ['tx_ttl'], index: 2 },
      { type: 'deleteNodes', nodeIds: ['tx_more'] },
      { type: 'setInstanceProps', changes: [{ nodeId: 'in_cbtn', set: { variant: 'outline' } }] },
      { type: 'updateStyles', nodeIds: ['el_card'], styles: { padding: '8px' } },
    ]);
  });

  it('main component: rejects deleting/moving the root, moving between page and main component, and repeated ids', () => {
    const doc = fixture();
    expect(() => applyOp(doc, { type: 'deleteNodes', nodeIds: ['el_card'] })).toThrow(/root/);
    expect(() => applyOp(doc, { type: 'moveNodes', nodeIds: ['el_card'], index: 0 })).toThrow(
      /root/,
    );
    expect(() =>
      applyOp(doc, { type: 'moveNodes', nodeIds: ['el_card'], parentId: 'fr_1' }),
    ).toThrow(/between/);
    expect(() =>
      applyOp(doc, {
        type: 'setPosition',
        changes: [{ nodeId: 'el_btn', position: { x: 1, y: 1 } }],
      }),
    ).toThrow(/no position/);
    expect(() =>
      applyOp(doc, { type: 'moveNodes', nodeIds: ['el_plain'], parentId: 'el_card' }),
    ).toThrow(/between a main component and a page/);
    expect(() =>
      applyOp(doc, {
        type: 'createNode',
        parentId: 'el_card',
        node: n('el_plain', 'element', 'div') as Node,
      }),
    ).toThrow(/el_plain/);
    expect(() =>
      applyOp(doc, {
        type: 'createNode',
        parentId: 'el_btn',
        node: n('in_loop', 'instance', 'div', { componentId: 'cp_card' }) as Node,
      }),
    ).toThrow(/cycle/);
  });

  it('duplicateNodes on the main component records the idMap for redo', () => {
    const doc = fixture();
    const h = new History(doc);
    const r = h.apply([{ type: 'duplicateNodes', nodeIds: ['tx_ttl'] }]);
    const filled = r.appliedOps[0] as Extract<Op, { type: 'duplicateNodes' }>;
    expect(filled.idMap?.tx_ttl).toMatch(/^tx_/);
    expect(comp(r.doc, 'cp_card').root.children[1].id).toBe(filled.idMap!.tx_ttl);
    h.undo();
    h.redo();
    expect(strip(h.doc)).toEqual(strip(r.doc));
  });

  it('virtual id whose owning instance is inside a main component becomes updateComponent', () => {
    const doc = fixture();
    const r = applyOp(doc, { type: 'setText', changes: [{ nodeId: 'in_cbtn/tx_lbl', text: 'Z' }] });
    expect(r.inverse[0].type).toBe('updateComponent');
    const inner = findInRoot(comp(r.doc, 'cp_card').root, 'in_cbtn')!;
    expect(inner.overrides).toEqual({ tx_lbl: { text: 'Z' } });
    expect(expandInstance(r.doc, node(r.doc, 'in_c1')).children[2].children[0].text).toBe('Z');
    roundTrip(doc, [{ type: 'setText', changes: [{ nodeId: 'in_cbtn/tx_lbl', text: 'Z' }] }]);
  });

  it('a mixed op (page + virtual + main component) is partitioned with a correct inverse', () => {
    const doc = fixture();
    const op: Op = {
      type: 'updateStyles',
      changes: [
        { nodeId: 'el_plain', set: { color: 'blue' } },
        { nodeId: 'in_b1/tx_lbl', set: { color: 'green' } },
        { nodeId: 'tx_ttl', set: { color: 'pink' } },
      ],
      nodeIds: ['in_c2/tx_ttl'],
      styles: { margin: '0' },
    };
    const d1 = roundTrip(doc, [op]);
    expect(node(d1, 'el_plain').style.color).toBe('blue');
    expect(node(d1, 'in_b1').overrides).toEqual({ tx_lbl: { style: { color: 'green' } } });
    expect(findInRoot(comp(d1, 'cp_card').root, 'tx_ttl')!.style.color).toBe('pink');
    expect(node(d1, 'in_c2').overrides).toEqual({ tx_ttl: { style: { margin: '0' } } });
    const del = roundTrip(doc, [{ type: 'deleteNodes', nodeIds: ['el_plain', 'tx_def'] }]);
    expect(findNode(del, 'el_plain')).toBeUndefined();
    expect(findInRoot(comp(del, 'cp_card').root, 'tx_def')).toBeUndefined();
    // applyOps (without History) also undoes.
    const r = applyOps(doc, [op]);
    expect(strip(applyOps(r.doc, r.inverse).doc)).toEqual(strip(doc));
  });
});

function findInRoot(root: Node, id: string): Node | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = findInRoot(c, id);
    if (f) return f;
  }
  return undefined;
}
