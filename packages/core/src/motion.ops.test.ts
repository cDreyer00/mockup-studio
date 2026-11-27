/**
 * `setMotion` op and everything that carries motion: inverse, history, validation, file round trip,
 * components (instance overrides), the HTML round trip and the tree summary.
 */
import { describe, expect, it } from 'vitest';
import { applyOp } from './apply.js';
import { expandDocument, getComponent } from './components/expand.js';
import { normalizeNodeMotion } from './components/ops.js';
import { findNode } from './document.js';
import { History } from './history.js';
import { htmlToNodes, nodesToHtml } from './html.js';
import { parseDocument, serializeDocument } from './schema.js';
import { summarizeNode } from './summary.js';
import type { Document, Node, NodeAnimation, SlideTransition } from './types.js';

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

const FADE_UP: NodeAnimation = { kind: 'in', preset: 'fade-up' };
const FLOAT: NodeAnimation = { kind: 'emphasis', preset: 'float' };
const PUSH: SlideTransition = { preset: 'push', direction: 'up', duration: 500 };

function fixture(): Document {
  return parseDocument({
    version: 1,
    id: 'doc_m',
    name: 'M',
    tokens: {},
    fonts: [],
    meta: { createdAt: 'x', updatedAt: 'x' },
    components: [
      {
        id: 'cp_card',
        name: 'Card',
        props: [],
        root: n('el_card', 'element', 'section', {
          children: [
            n('tx_title01', 'text', 'h2', { text: 'Hello', animations: [FADE_UP] }),
            n('el_body001', 'element', 'div'),
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
            style: { width: '800px', height: '600px' },
            children: [
              n('el_a', 'element', 'div'),
              n('tx_a', 'text', 'p', { text: 'one two' }),
              n('in_a', 'instance', 'section', { componentId: 'cp_card' }),
              n('in_b', 'instance', 'section', { componentId: 'cp_card' }),
            ] as Node[],
          }),
          n('fr_2', 'frame', 'div', { position: { x: 900, y: 0 } }),
        ],
      },
    ],
  });
}

const strip = (doc: Document): unknown => {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
};

const node = (doc: Document, id: string): Node => {
  const p = findNode(doc, id);
  if (!p) throw new Error(`no ${id}`);
  return p.node;
};
const view = (doc: Document, id: string): Node => node(expandDocument(doc), id);

describe('setMotion', () => {
  it('applies animations and an exact inverse', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'el_a', animations: [{ ...FADE_UP, duration: 600, delay: 0 }, FLOAT] }],
    });
    expect(node(r.doc, 'el_a').animations).toEqual([FADE_UP, FLOAT]);
    expect(r.inverse).toEqual([
      { type: 'setMotion', changes: [{ nodeId: 'el_a', animations: null }] },
    ]);
    const back = applyOp(r.doc, r.inverse[0]!);
    expect(strip(back.doc)).toEqual(strip(doc));
    // replacing restores the previous list
    const r2 = applyOp(r.doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'el_a', animations: null }],
    });
    expect(node(r2.doc, 'el_a').animations).toBeUndefined();
    expect(r2.inverse[0]).toEqual({
      type: 'setMotion',
      changes: [{ nodeId: 'el_a', animations: [FADE_UP, FLOAT] }],
    });
    expect(strip(applyOp(r2.doc, r2.inverse[0]!).doc)).toEqual(strip(r.doc));
  });

  it('[] deletes the animations like null', () => {
    const r = applyOp(fixture(), {
      type: 'setMotion',
      changes: [{ nodeId: 'el_a', animations: [FADE_UP] }],
    });
    const cleared = applyOp(r.doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'el_a', animations: [] }],
    });
    expect(node(cleared.doc, 'el_a')).not.toHaveProperty('animations');
  });

  it('sets and removes the transition of a root frame, with exact inverses', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'fr_2', transition: PUSH, animations: [FADE_UP] }],
    });
    expect(node(r.doc, 'fr_2').slideTransition).toEqual(PUSH);
    expect(strip(applyOp(r.doc, r.inverse[0]!).doc)).toEqual(strip(doc));
    const off = applyOp(r.doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'fr_2', transition: null }],
    });
    expect(node(off.doc, 'fr_2')).not.toHaveProperty('slideTransition');
    expect(strip(applyOp(off.doc, off.inverse[0]!).doc)).toEqual(strip(r.doc));
  });

  it('inverse changes come in reverse order', () => {
    const r = applyOp(fixture(), {
      type: 'setMotion',
      changes: [
        { nodeId: 'el_a', animations: [FADE_UP] },
        { nodeId: 'tx_a', animations: [FLOAT] },
      ],
    });
    const inv = r.inverse[0] as { changes: { nodeId: string }[] };
    expect(inv.changes.map((c) => c.nodeId)).toEqual(['tx_a', 'el_a']);
  });

  it('undoes and redoes through the history', () => {
    const doc = fixture();
    const h = new History(doc);
    h.apply(
      [
        { type: 'setMotion', changes: [{ nodeId: 'el_a', animations: [FADE_UP] }] },
        { type: 'setMotion', changes: [{ nodeId: 'fr_1', transition: PUSH }] },
      ],
      'motion',
    );
    expect(node(h.doc, 'el_a').animations).toEqual([FADE_UP]);
    expect(node(h.doc, 'fr_1').slideTransition).toEqual(PUSH);
    h.undo();
    expect(strip(h.doc)).toEqual(strip(doc));
    h.redo();
    expect(node(h.doc, 'el_a').animations).toEqual([FADE_UP]);
    expect(node(h.doc, 'fr_1').slideTransition).toEqual(PUSH);
  });

  it('rejects invalid input with readable errors', () => {
    const doc = fixture();
    const run = (changes: unknown): void => {
      applyOp(doc, { type: 'setMotion', changes } as never);
    };
    expect(() => run([{ nodeId: 'el_a' }])).toThrow(/provide animations and\/or transition/);
    expect(() => run([{ nodeId: 'nope', animations: [] }])).toThrow(/Node not found/);
    expect(() => run([{ nodeId: 'el_a', animations: [{ kind: 'in', preset: 'nope' }] }])).toThrow(
      /setMotion on "el_a".*unknown preset/,
    );
    expect(() => run([{ nodeId: 'el_a', transition: PUSH }])).toThrow(
      'Slide transitions only apply to root frames (slides); "el_a" is not one',
    );
    expect(() =>
      run([{ nodeId: 'fr_1', transition: { preset: 'fade', direction: 'left' } }]),
    ).toThrow(/no direction/);
    expect(() =>
      run([{ nodeId: 'el_a', animations: [{ kind: 'in', preset: 'fade', split: 'words' }] }]),
    ).toThrow(/only apply to text nodes/);
    // split words is fine on a text node
    expect(() =>
      run([{ nodeId: 'tx_a', animations: [{ kind: 'in', preset: 'fade', split: 'words' }] }]),
    ).not.toThrow();
  });

  it('keeps normalized animations of created nodes and drops invalid ones', () => {
    const doc = fixture();
    const bad = applyOp(doc, {
      type: 'createNode',
      parentId: 'fr_1',
      node: n('el_bad', 'element', 'div', {
        animations: [{ kind: 'in', preset: 'nope' }],
      }) as Node,
    });
    expect(node(bad.doc, 'el_bad')).not.toHaveProperty('animations');
    const ok = applyOp(doc, {
      type: 'createNode',
      parentId: 'fr_1',
      node: n('el_new', 'element', 'div', {
        animations: [{ kind: 'in', preset: 'fade-up', duration: 600 }],
      }) as Node,
    });
    expect(node(ok.doc, 'el_new').animations).toEqual([FADE_UP]);
  });

  it('a text split on a created non-text node is dropped on read and rejected unparsed', () => {
    const words = { kind: 'in', preset: 'fade', split: 'words', stagger: 40 } as const;
    const r = applyOp(fixture(), {
      type: 'createNode',
      parentId: 'fr_1',
      node: n('el_split', 'element', 'div', { animations: [words, FLOAT] }) as Node,
    });
    expect(node(r.doc, 'el_split').animations).toEqual([{ kind: 'in', preset: 'fade' }, FLOAT]);
    const t = applyOp(fixture(), {
      type: 'createNode',
      parentId: 'fr_1',
      node: n('tx_split', 'text', 'p', { text: 'a b', animations: [words] }) as Node,
    });
    expect(node(t.doc, 'tx_split').animations).toEqual([words]);
    // straight to the normalizer (no lenient parse first): same rule as setMotion
    const raw = n('el_raw', 'element', 'div', { animations: [words] }) as Node;
    expect(() => normalizeNodeMotion(raw)).toThrow(/split "words" and "chars" only apply to text/);
    const ok = n('el_kids', 'element', 'div', { animations: [{ ...words, split: 'children' }] });
    expect(() => normalizeNodeMotion(ok as Node)).not.toThrow();
  });
});

describe('file round trip', () => {
  it('serializes animations and transition in a stable key order and parses them back', () => {
    const doc = applyOp(fixture(), {
      type: 'setMotion',
      changes: [
        {
          nodeId: 'tx_a',
          animations: [
            {
              keyframes: [{ opacity: '0', offset: 0 }, { opacity: '1' }],
              preset: 'custom',
              kind: 'in',
              build: 1,
              delay: 50,
              duration: 300,
            },
            { stagger: 20, split: 'chars', kind: 'in', preset: 'fade', easing: 'spring' },
          ],
        },
        { nodeId: 'fr_1', transition: { direction: 'up', duration: 500, preset: 'push' } },
      ],
    }).doc;
    const json = serializeDocument(doc);
    const raw = JSON.parse(json) as { pages: { frames: Record<string, unknown>[] }[] };
    const frame = raw.pages[0]!.frames[0]!;
    expect(Object.keys(frame.slideTransition as object)).toEqual([
      'preset',
      'duration',
      'direction',
    ]);
    const text = (frame.children as Record<string, unknown>[])[1]!;
    const anims = text.animations as Record<string, unknown>[];
    expect(Object.keys(anims[0]!)).toEqual([
      'kind',
      'preset',
      'duration',
      'delay',
      'build',
      'keyframes',
    ]);
    expect(Object.keys(anims[1]!)).toEqual(['kind', 'preset', 'easing', 'split', 'stagger']);
    // right after `states`/`classes`, before `locked`
    const keys = Object.keys(text);
    expect(keys.indexOf('animations')).toBeGreaterThan(keys.indexOf('style'));
    expect(keys.indexOf('animations')).toBeLessThan(keys.indexOf('locked'));
    const again = parseDocument(json);
    expect(node(again, 'tx_a').animations).toEqual(node(doc, 'tx_a').animations);
    expect(node(again, 'fr_1').slideTransition).toEqual(node(doc, 'fr_1').slideTransition);
    expect(serializeDocument(again)).toBe(json);
  });

  it('documents without motion serialize without the fields', () => {
    const json = serializeDocument(fixture());
    expect(json).not.toContain('slideTransition');
    expect(serializeDocument(parseDocument(json))).toBe(json);
  });

  it('reads leniently: invalid animations and transitions are dropped, valid ones kept', () => {
    const raw = JSON.parse(serializeDocument(fixture())) as {
      pages: { frames: Record<string, unknown>[] }[];
    };
    const frame = raw.pages[0]!.frames[0]!;
    frame.slideTransition = { preset: 'does-not-exist' };
    const kids = frame.children as Record<string, unknown>[];
    kids[0]!.animations = [{ kind: 'in', preset: 'nope' }, FADE_UP, { nonsense: true }];
    kids[1]!.animations = [{ kind: 'in', preset: 'nope' }];
    const doc = parseDocument(raw);
    expect(node(doc, 'el_a').animations).toEqual([FADE_UP]);
    expect(node(doc, 'tx_a')).not.toHaveProperty('animations');
    expect(node(doc, 'fr_1')).not.toHaveProperty('slideTransition');
  });

  it('reads a text split on a non-text node as a whole-node animation', () => {
    const raw = JSON.parse(serializeDocument(fixture())) as {
      pages: { frames: Record<string, unknown>[] }[];
    };
    const kids = raw.pages[0]!.frames[0]!.children as Record<string, unknown>[];
    kids[0]!.animations = [{ kind: 'in', preset: 'fade', split: 'chars', stagger: 10 }];
    kids[1]!.animations = [{ kind: 'in', preset: 'fade', split: 'chars', stagger: 10 }];
    const doc = parseDocument(raw);
    expect(node(doc, 'el_a').animations).toEqual([{ kind: 'in', preset: 'fade' }]);
    expect(node(doc, 'tx_a').animations).toEqual([
      { kind: 'in', preset: 'fade', split: 'chars', stagger: 10 },
    ]);
  });
});

describe('components', () => {
  it('setMotion on a virtual id creates an animations override only for that instance', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'in_a/tx_title01', animations: [{ kind: 'in', preset: 'zoom-in' }] }],
    });
    expect(node(r.doc, 'in_a').overrides).toEqual({
      tx_title01: { animations: [{ kind: 'in', preset: 'zoom-in' }] },
    });
    expect(view(r.doc, 'in_a/tx_title01').animations).toEqual([{ kind: 'in', preset: 'zoom-in' }]);
    expect(view(r.doc, 'in_b/tx_title01').animations).toEqual([FADE_UP]);
    expect(getComponent(r.doc, 'cp_card')!.root.children[0]!.animations).toEqual([FADE_UP]);
    expect(strip(applyOp(r.doc, r.inverse[0]!).doc)).toEqual(strip(doc));
    // survives the file round trip
    expect(node(parseDocument(serializeDocument(r.doc)), 'in_a').overrides).toEqual(
      node(r.doc, 'in_a').overrides,
    );
  });

  it('an empty override removes the animations in that instance only', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'in_a/tx_title01', animations: null }],
    });
    expect(node(r.doc, 'in_a').overrides).toEqual({ tx_title01: { animations: [] } });
    expect(view(r.doc, 'in_a/tx_title01').animations).toBeUndefined();
    expect(view(r.doc, 'in_b/tx_title01').animations).toEqual([FADE_UP]);
    const reparsed = parseDocument(serializeDocument(r.doc));
    expect(node(reparsed, 'in_a').overrides).toEqual({ tx_title01: { animations: [] } });
    expect(view(reparsed, 'in_a/tx_title01').animations).toBeUndefined();
  });

  it('validates on a virtual id and refuses transitions there', () => {
    const doc = fixture();
    expect(() =>
      applyOp(doc, {
        type: 'setMotion',
        changes: [{ nodeId: 'in_a/tx_title01', animations: [{ kind: 'in', preset: 'nope' }] }],
      }),
    ).toThrow(/unknown preset/);
    expect(() =>
      applyOp(doc, {
        type: 'setMotion',
        changes: [{ nodeId: 'in_a/tx_title01', transition: PUSH }],
      }),
    ).toThrow(/only apply to root frames/);
  });

  it('animations and the slide transition set on an instance itself reach the expanded view', () => {
    const doc = fixture();
    // an instance used as a slide (root frame)
    doc.pages[0]!.frames.push({
      ...structuredClone(node(doc, 'in_b')),
      id: 'in_slide',
      position: { x: 0, y: 700 },
    });
    const r = applyOp(doc, {
      type: 'setMotion',
      changes: [
        { nodeId: 'in_a', animations: [FLOAT] },
        { nodeId: 'in_slide', transition: PUSH },
      ],
    });
    expect(view(r.doc, 'in_a').animations).toEqual([FLOAT]);
    expect(view(r.doc, 'in_b').animations).toBeUndefined();
    // the layers of the component keep their own animations
    expect(view(r.doc, 'in_a/tx_title01').animations).toEqual([FADE_UP]);
    expect(view(r.doc, 'in_slide').slideTransition).toEqual(PUSH);
    const reparsed = parseDocument(serializeDocument(r.doc));
    expect(view(reparsed, 'in_a').animations).toEqual([FLOAT]);
    expect(view(reparsed, 'in_slide').slideTransition).toEqual(PUSH);
    const undone = r.inverse.reduce((d, op) => applyOp(d, op).doc, r.doc);
    expect(strip(undone)).toEqual(strip(doc));
  });

  it('an instance without its own animations keeps those of the main component root', () => {
    let doc = fixture();
    doc = applyOp(doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'el_card', animations: [FLOAT] }],
    }).doc;
    expect(view(doc, 'in_a').animations).toEqual([FLOAT]);
    // its own list replaces the main one in that instance only
    doc = applyOp(doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'in_a', animations: [FADE_UP] }],
    }).doc;
    expect(view(doc, 'in_a').animations).toEqual([FADE_UP]);
    expect(view(doc, 'in_b').animations).toEqual([FLOAT]);
  });

  it('setMotion on a main component node edits the component', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMotion',
      changes: [{ nodeId: 'el_body001', animations: [FLOAT] }],
    });
    expect(getComponent(r.doc, 'cp_card')!.root.children[1]!.animations).toEqual([FLOAT]);
    expect(view(r.doc, 'in_b/el_body001').animations).toEqual([FLOAT]);
    expect(strip(applyOp(r.doc, r.inverse[0]!).doc)).toEqual(strip(doc));
  });
});

describe('html round trip', () => {
  it('keeps animations and the transition', () => {
    const doc = applyOp(fixture(), {
      type: 'setMotion',
      changes: [
        { nodeId: 'tx_a', animations: [{ kind: 'in', preset: 'fade', split: 'words' }, FLOAT] },
        { nodeId: 'fr_1', transition: PUSH },
      ],
    }).doc;
    const { html } = nodesToHtml(node(doc, 'fr_1'), { indent: false });
    expect(html).toContain('data-motion-transition="{&quot;preset&quot;:&quot;push&quot;');
    expect(html).toContain('data-motion="[{&quot;kind&quot;:&quot;in&quot;');
    const [frame] = htmlToNodes(html);
    expect(frame!.slideTransition).toEqual(PUSH);
    expect(frame!.attrs).toEqual({});
    const text = frame!.children.find((c) => c.text === 'one two')!;
    expect(text.animations).toEqual(node(doc, 'tx_a').animations);
    expect(text.attrs).toEqual({});
  });

  it('keeps animations on video, image and svg nodes', () => {
    const nodes = htmlToNodes(
      '<video src="https://example.com/a.mp4"></video>' +
        '<img src="https://example.com/a.png" alt="a">' +
        '<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>',
    );
    expect(nodes.map((x) => x.type)).toEqual(['video', 'image', 'svg']);
    const anims: NodeAnimation[] = [FADE_UP, { ...FLOAT, build: 1 }];
    for (const x of nodes) x.animations = anims;
    const back = nodes.flatMap((x) => htmlToNodes(nodesToHtml(x, { indent: false }).html));
    expect(back.map((x) => x.type)).toEqual(['video', 'image', 'svg']);
    for (const x of back) {
      expect(x.animations).toEqual(anims);
      expect(x.attrs['data-motion']).toBeUndefined();
    }
  });

  it('ignores invalid JSON and invalid values', () => {
    const [a, b, c] = htmlToNodes(
      `<div data-motion="not json"></div>` +
        `<div data-motion='[{"kind":"in","preset":"nope"},{"kind":"in","preset":"fade"}]' data-motion-transition='{"preset":"zzz"}'></div>` +
        `<div data-motion-transition="{"></div>`,
    );
    expect(a!.animations).toBeUndefined();
    expect(b!.animations).toEqual([{ kind: 'in', preset: 'fade' }]);
    expect(b!.slideTransition).toBeUndefined();
    expect(c!.slideTransition).toBeUndefined();
    expect(b!.attrs).toEqual({});
  });

  it('drops a text split on a non-text element but keeps the animation', () => {
    const [div] = htmlToNodes(
      `<div data-motion='[{"kind":"in","preset":"fade","split":"words"}]'><p>a</p><p>b</p></div>`,
    );
    expect(div!.animations).toEqual([{ kind: 'in', preset: 'fade' }]);
  });
});

describe('tree summary', () => {
  it('marks animated nodes and transitions', () => {
    const doc = applyOp(fixture(), {
      type: 'setMotion',
      changes: [
        {
          nodeId: 'el_a',
          animations: [
            { kind: 'in', preset: 'fade-up', build: 1 },
            { kind: 'emphasis', preset: 'float' },
          ],
        },
        { nodeId: 'tx_a', animations: [{ kind: 'in', preset: 'fade' }] },
        { nodeId: 'fr_1', transition: PUSH },
        { nodeId: 'fr_2', transition: { preset: 'fade' } },
      ],
    }).doc;
    expect(summarizeNode(node(doc, 'el_a'))).toContain('motion:in fade-up+b1,emphasis float');
    expect(summarizeNode(node(doc, 'tx_a'))).toContain('motion:in fade');
    expect(summarizeNode(node(doc, 'fr_1'))).toContain('transition:push-up');
    expect(summarizeNode(node(doc, 'fr_2'))).toContain('transition:fade');
    expect(summarizeNode(node(doc, 'fr_2'))).not.toContain('transition:fade-');
    expect(summarizeNode(node(fixture(), 'el_a'))).not.toContain('motion');
  });
});
