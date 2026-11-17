import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOp } from '../apply.js';
import { parseOp } from '../ops.schema.js';
import { parseDocument, serializeDocument, validateDocument } from '../schema.js';
import type { ComponentDef, Node } from '../types.js';
import { expandDocument, expandInstance, expandNodeTree } from './expand.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

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

function raw(extra: { components?: unknown[]; nodes?: Raw[] } = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'doc_s',
    name: 'S',
    tokens: {},
    fonts: [],
    meta: { createdAt: 'x', updatedAt: 'y' },
    ...(extra.components && { components: extra.components }),
    pages: [
      {
        id: 'pg_1',
        name: 'P',
        background: '#fff',
        frames: [
          n('fr_1', 'frame', 'div', {
            position: { x: 0, y: 0 },
            children: (extra.nodes ?? []) as Node[],
          }),
        ],
      },
    ],
  };
}

const button = {
  id: 'cp_btn',
  name: 'Button',
  description: 'Botão',
  props: [{ name: 'label', type: 'string', default: 'OK' }],
  root: n('el_btn', 'element', 'button', {
    children: [
      n('tx_lbl', 'text', 'span', { text: '{{label}}', style: { color: '{{label}}' } }),
    ] as Node[],
  }),
  variants: [{ when: { label: 'X' }, overrides: { '': { style: { color: 'red' } } } }],
};

describe('schema com componentes', () => {
  it('documento antigo (sem components) continua igual', () => {
    const text = read('../../../../examples/landing.mockup.json');
    const doc = parseDocument(text);
    expect('components' in doc).toBe(false);
    const out = serializeDocument(doc);
    expect(out).not.toContain('"components"');
    expect(serializeDocument(parseDocument(out))).toBe(out);
    // components vazio também some.
    expect('components' in parseDocument({ ...JSON.parse(text), components: [] })).toBe(false);
  });

  it('round-trip com componentes e instâncias, ordem estável', () => {
    const doc = parseDocument(
      raw({
        components: [button],
        nodes: [
          n('in_1', 'instance', 'button', {
            componentId: 'cp_btn',
            props: { label: 'Salvar' },
            overrides: { tx_lbl: { text: 'Y', style: { 'font-weight': '700' } } },
          }),
        ],
      }),
    );
    const out = serializeDocument(doc);
    expect(parseDocument(out)).toEqual(doc);
    expect(serializeDocument(parseDocument(out))).toBe(out);
    const j = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual([
      'version',
      'id',
      'name',
      'tokens',
      'fonts',
      'meta',
      'components',
      'pages',
    ]);
    const comp = (j.components as Record<string, unknown>[])[0];
    expect(Object.keys(comp)).toEqual(['id', 'name', 'description', 'props', 'variants', 'root']);
    const inst = (j.pages as { frames: { children: Record<string, unknown>[] }[] }[])[0].frames[0]
      .children[0];
    expect(Object.keys(inst)).toEqual([
      'id',
      'type',
      'name',
      'tag',
      'componentId',
      'attrs',
      'style',
      'props',
      'overrides',
      'locked',
      'hidden',
      'children',
    ]);
  });

  it('instância: campos vazios somem, estilos inseguros e svg perigoso são limpos', () => {
    const doc = parseDocument(
      raw({
        components: [button],
        nodes: [
          n('in_1', 'instance', 'button', {
            componentId: 'cp_btn',
            props: {},
            overrides: {
              tx_lbl: {
                style: { color: 'red; } body { x: y', margin: '0' },
                attrs: { onclick: 'alert(1)', title: 'ok' },
                svg: '<svg><script>alert(1)</script><path d="M0 0"/></svg>',
              },
              empty: {},
            },
          }),
          n('in_2', 'instance', 'button', { componentId: 'cp_btn', overrides: {} }),
        ],
      }),
    );
    const [i1, i2] = doc.pages[0].frames[0].children;
    expect(i1.props).toBeUndefined();
    expect(i1.overrides!.tx_lbl.style).toEqual({ margin: '0' });
    expect(i1.overrides!.tx_lbl.attrs).toEqual({ title: 'ok' });
    expect(i1.overrides!.tx_lbl.svg).not.toContain('script');
    expect(i1.overrides!.empty).toBeUndefined();
    expect('overrides' in i2).toBe(false);
  });

  it('recusa instância sem componente, raiz frame, nomes e ids repetidos', () => {
    const bad = (input: Record<string, unknown>, re: RegExp): void => {
      const r = validateDocument(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join('; ')).toMatch(re);
    };
    bad(raw({ nodes: [n('in_1', 'instance', 'div')] }), /componentId/);
    bad(raw({ components: [{ ...button, root: { ...button.root, type: 'frame' } }] }), /raiz/);
    bad(
      raw({ components: [button, { ...button, id: 'cp_b2', root: n('el_b2', 'element', 'div') }] }),
      /nome duplicado/,
    );
    bad(raw({ components: [button], nodes: [n('tx_lbl', 'text', 'p')] }), /tx_lbl/);
  });
});

describe('variante sem condição (when vazio)', () => {
  const empty = { when: {}, overrides: { '': { style: { color: 'blue' } } } };

  it('na leitura de arquivo é descartada (o documento continua válido)', () => {
    const doc = parseDocument(
      raw({
        components: [{ ...button, variants: [empty, ...button.variants, { overrides: {} }] }],
      }),
    );
    expect(doc.components![0]!.variants).toEqual(button.variants);
  });

  it('nas ops é recusada com mensagem clara (schema e handler)', () => {
    const msg = /variante sem condição: mova os estilos para o principal/;
    expect(() =>
      parseOp({ type: 'addComponent', component: { ...button, variants: [empty] } }),
    ).toThrow(msg);
    expect(() =>
      parseOp({ type: 'updateComponent', componentId: 'cp_btn', variants: [empty] }),
    ).toThrow(msg);
    const doc = parseDocument(raw({ components: [button] }));
    // Sem passar pelo schema (planejadores, editor): o handler também recusa.
    expect(() =>
      applyOp(doc, { type: 'updateComponent', componentId: 'cp_btn', variants: [empty] }),
    ).toThrow(msg);
    const other = {
      ...button,
      id: 'cp_b2',
      name: 'B2',
      root: n('el_b2', 'element', 'div'),
      variants: [empty],
    } as unknown as ComponentDef;
    expect(() => applyOp(doc, { type: 'addComponent', component: other })).toThrow(msg);
  });

  it('a expansão ignora uma variante vazia que escape da validação', () => {
    const doc = parseDocument(
      raw({
        components: [button],
        nodes: [n('in_1', 'instance', 'button', { componentId: 'cp_btn' })],
      }),
    );
    doc.components![0]!.variants = [empty];
    const out = expandInstance(doc, doc.pages[0]!.frames[0]!.children[0]!, { warnings: [] });
    expect(out.style.color).toBeUndefined();
  });
});

describe('kit shadcn-like', () => {
  it('nenhuma variante do kit tem when vazio', () => {
    const json = JSON.parse(read('../../../../kits/shadcn-like.mockup.json')) as {
      components: { variants?: { when?: Record<string, unknown> }[] }[];
    };
    const variants = json.components.flatMap((c) => c.variants ?? []);
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.every((v) => Object.keys(v.when ?? {}).length > 0)).toBe(true);
  });

  const text = read('../../../../kits/shadcn-like.mockup.json');

  it('carrega e expande a vitrine sem avisos nem placeholders sobrando', () => {
    const kit = parseDocument(text);
    expect(kit.components!.map((c) => c.name)).toEqual([
      'Button',
      'Input',
      'Card',
      'Navbar',
      'Tabs',
      'Dialog',
      'Table',
      'List',
    ]);
    const warnings: string[] = [];
    const frames = kit.pages.flatMap((p) =>
      p.frames.map((f) => expandNodeTree(kit, f, { warnings })),
    );
    expect(warnings).toEqual([]);
    const json = JSON.stringify(frames);
    expect(json).not.toContain('{{');
    expect(json).not.toContain('Componente ausente');
    expect(json).not.toContain('"type":"instance"');
    expect(JSON.stringify(expandDocument(kit).pages)).toBe(
      JSON.stringify(kit.pages.map((p) => ({ ...p, frames: frames }))),
    );
    expect(serializeDocument(parseDocument(serializeDocument(kit)))).toBe(serializeDocument(kit));
  });
});
