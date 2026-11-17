import { describe, expect, it } from 'vitest';
import { parseDocument } from '../schema.js';
import type { Document, Node } from '../types.js';
import {
  MAX_EXPANDED_NODES,
  TOO_LARGE_COMPONENT_TEXT,
  expandDocument,
  expandInstance,
  expandedSize,
  expandNodeTree,
  findComponentCycle,
  isVirtualId,
  splitVirtualId,
} from './expand.js';

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

/** Button (variant/label) e Card (title, slot content, Button aninhado); instâncias na página. */
function fixture(pageNodes: Raw[] = defaultPage()): Document {
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
          style: { display: 'inline-flex', background: 'var(--c)', padding: '8px' },
          states: { hover: { opacity: '0.9' } },
          children: [
            n('tx_lbl', 'text', 'span', { text: '{{label}}', style: { color: 'white' } }),
          ] as Node[],
        }),
        variants: [
          {
            when: { variant: 'outline' },
            overrides: {
              '': { style: { background: 'transparent' } },
              tx_lbl: { style: { color: 'red' } },
            },
          },
        ],
      },
      {
        id: 'cp_card',
        name: 'Card',
        props: [
          { name: 'title', type: 'string', default: 'Título' },
          { name: 'content', type: 'slot' },
        ],
        root: n('el_card', 'element', 'div', {
          style: { display: 'flex' },
          children: [
            n('tx_ttl', 'text', 'h3', { text: '{{title}}' }),
            n('el_body', 'element', 'div', {
              attrs: { 'data-slot': 'content' },
              style: { display: 'flex', gap: '8px' },
              children: [n('tx_def', 'text', 'p', { text: 'Padrão' })] as Node[],
            }),
            n('in_cbtn', 'instance', 'button', { componentId: 'cp_btn', props: { label: 'Ação' } }),
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
          n('fr_1', 'frame', 'div', { position: { x: 0, y: 0 }, children: pageNodes as Node[] }),
        ],
      },
    ],
  });
}

function defaultPage(): Raw[] {
  return [
    n('in_b1', 'instance', 'button', {
      componentId: 'cp_btn',
      props: { variant: 'outline', label: 'Salvar' },
    }),
    n('in_c1', 'instance', 'div', {
      componentId: 'cp_card',
      props: { title: 'T1' },
      children: [
        n('el_s1', 'element', 'div', {
          attrs: { 'data-slot': 'content' },
          style: { padding: '4px' },
          children: [n('tx_s1', 'text', 'p', { text: 'Meu' })] as Node[],
        }),
      ] as Node[],
    }),
    n('in_c2', 'instance', 'div', { componentId: 'cp_card' }),
    n('el_plain', 'element', 'div', {
      children: [n('tx_plain', 'text', 'p', { text: 'oi' })] as Node[],
    }),
  ];
}

function inst(doc: Document, id: string): Node {
  return doc.pages[0].frames[0].children.find((c) => c.id === id)!;
}

function find(root: Node, id: string): Node | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = find(c, id);
    if (f) return f;
  }
  return undefined;
}

describe('ids virtuais', () => {
  it('isVirtualId e splitVirtualId', () => {
    expect(isVirtualId('in_a/tx_b')).toBe(true);
    expect(isVirtualId('tx_b')).toBe(false);
    expect(splitVirtualId('in_a/in_b/tx_c')).toEqual({
      instanceId: 'in_a',
      path: 'in_b/tx_c',
      segments: ['in_b', 'tx_c'],
    });
    expect(splitVirtualId('tx_b')).toBeNull();
  });
});

describe('expandInstance', () => {
  it('props, placeholders e variantes', () => {
    const doc = fixture();
    const out = expandInstance(doc, inst(doc, 'in_b1'));
    expect(out.id).toBe('in_b1');
    expect(out.type).toBe('element');
    expect(out.tag).toBe('button');
    expect(out.componentId).toBe('cp_btn');
    expect(out.props).toEqual({ variant: 'outline', label: 'Salvar' });
    expect(out.overrides).toBeUndefined();
    expect(out.style).toEqual({
      display: 'inline-flex',
      background: 'transparent',
      padding: '8px',
    });
    expect(out.states).toEqual({ hover: { opacity: '0.9' } });
    expect(out.children[0].id).toBe('in_b1/tx_lbl');
    expect(out.children[0].text).toBe('Salvar');
    expect(out.children[0].style.color).toBe('red');
  });

  it('padrões quando a instância não tem props', () => {
    const doc = fixture([n('in_x', 'instance', 'button', { componentId: 'cp_btn' })]);
    const out = expandInstance(doc, inst(doc, 'in_x'));
    expect(out.children[0].text).toBe('OK');
    expect(out.style.background).toBe('var(--c)');
    expect(out.children[0].style.color).toBe('white');
  });

  it('slot preenchido: id e estilo do contêiner real, conteúdo real', () => {
    const doc = fixture();
    const out = expandInstance(doc, inst(doc, 'in_c1'));
    const body = out.children[1];
    expect(body.id).toBe('el_s1');
    expect(body.style).toEqual({ display: 'flex', gap: '8px', padding: '4px' });
    expect(body.children.map((c) => c.id)).toEqual(['tx_s1']);
    expect(out.children[0].text).toBe('T1');
    // Instância aninhada no principal: ids virtuais encadeados.
    const btn = out.children[2];
    expect(btn.id).toBe('in_c1/in_cbtn');
    expect(btn.componentId).toBe('cp_btn');
    expect(btn.children[0].id).toBe('in_c1/in_cbtn/tx_lbl');
    expect(btn.children[0].text).toBe('Ação');
  });

  it('slot vazio ou ausente: conteúdo padrão com ids virtuais', () => {
    const doc = fixture();
    const out = expandInstance(doc, inst(doc, 'in_c2'));
    expect(out.children[1].id).toBe('in_c2/el_body');
    expect(out.children[1].children[0].id).toBe('in_c2/tx_def');
    expect(out.children[1].children[0].text).toBe('Padrão');
    expect(out.children[0].text).toBe('Título');
  });

  it('override do contêiner de slot do principal entra entre o principal e o da instância', () => {
    const doc = fixture([
      n('in_c', 'instance', 'div', {
        componentId: 'cp_card',
        overrides: { el_body: { style: { gap: '2px', color: 'blue' } } },
        children: [
          n('el_sc', 'element', 'div', {
            attrs: { 'data-slot': 'content' },
            style: { gap: '1px' },
          }),
        ] as Node[],
      }),
    ]);
    const body = expandInstance(doc, inst(doc, 'in_c')).children[1];
    expect(body.id).toBe('el_sc');
    expect(body.style).toEqual({ display: 'flex', gap: '1px', color: 'blue' });
    // Contêiner real vazio: conteúdo padrão.
    expect(body.children[0].id).toBe('in_c/tx_def');
  });

  it('overrides por caminho, inclusive em instância aninhada', () => {
    const doc = fixture([
      n('in_c', 'instance', 'div', {
        componentId: 'cp_card',
        overrides: {
          tx_ttl: { text: 'X', style: { color: 'green' } },
          'in_cbtn/tx_lbl': { text: 'Y' },
          in_cbtn: { props: { variant: 'outline' } },
          tx_def: { hidden: true },
          el_gone: { text: 'ignorado' },
        },
      }),
    ]);
    const out = expandInstance(doc, inst(doc, 'in_c'));
    expect(out.children[0].text).toBe('X');
    expect(out.children[0].style.color).toBe('green');
    expect(out.children[1].children[0].hidden).toBe(true);
    const btn = out.children[2];
    expect(btn.props).toEqual({ label: 'Ação', variant: 'outline' });
    expect(btn.style.background).toBe('transparent');
    expect(btn.children[0].text).toBe('Y');
    expect(btn.children[0].style.color).toBe('red');
  });

  it('override da instância ganha da variante; unsetStyle remove do principal', () => {
    const doc = fixture([
      n('in_x', 'instance', 'button', {
        componentId: 'cp_btn',
        props: { variant: 'outline' },
        overrides: { tx_lbl: { style: { color: 'pink' } }, '': { unsetStyle: ['padding'] } },
      }),
    ]);
    const out = expandInstance(doc, inst(doc, 'in_x'));
    expect(out.children[0].style.color).toBe('pink');
    expect(out.style.padding).toBeUndefined();
  });

  it('raiz mesclada com style/attrs/states/classes da instância; posição, nome e flags dela', () => {
    const doc = fixture([
      n('in_x', 'instance', 'button', {
        componentId: 'cp_btn',
        name: 'Meu botão',
        style: { margin: '4px', background: 'green' },
        attrs: { 'aria-label': 'Salvar' },
        states: { hover: { background: 'black' } },
        classes: 'm-1',
        position: { x: 3, y: 4 },
        locked: true,
      }),
    ]);
    const out = expandInstance(doc, inst(doc, 'in_x'));
    expect(out.style).toEqual({
      display: 'inline-flex',
      background: 'green',
      padding: '8px',
      margin: '4px',
    });
    expect(out.attrs).toEqual({ 'aria-label': 'Salvar' });
    expect(out.states).toEqual({ hover: { opacity: '0.9', background: 'black' } });
    expect(out.classes).toBe('m-1');
    expect(out.position).toEqual({ x: 3, y: 4 });
    expect(out.name).toBe('Meu botão');
    expect(out.locked).toBe(true);
  });

  it('placeholder em estilo: valor final inseguro é descartado', () => {
    const doc = fixture([n('in_x', 'instance', 'button', { componentId: 'cp_btn' })]);
    doc.components![0].root.style.color = '{{label}}';
    doc.components![0].props[1].default = 'red; } body { x: y';
    const out = expandInstance({ ...doc, components: [...doc.components!] }, inst(doc, 'in_x'));
    expect(out.style.color).toBeUndefined();
  });

  it('componente ausente vira contêiner de aviso', () => {
    const doc = fixture([
      n('in_x', 'instance', 'div', { componentId: 'cp_none', position: { x: 1, y: 2 } }),
    ]);
    const warnings: string[] = [];
    const out = expandInstance(doc, inst(doc, 'in_x'), { warnings });
    expect(out.id).toBe('in_x');
    expect(out.children[0].text).toBe('Componente ausente');
    expect(out.position).toEqual({ x: 1, y: 2 });
    expect(warnings[0]).toMatch(/cp_none/);
  });

  it('ciclo vira aviso (sem recursão infinita)', () => {
    const doc = fixture([n('in_x', 'instance', 'div', { componentId: 'cp_card' })]);
    // Button passa a conter um Card: Card → Button → Card.
    doc.components = doc.components!.map((c) =>
      c.id === 'cp_btn'
        ? {
            ...c,
            root: {
              ...c.root,
              children: [
                ...c.root.children,
                n('in_loop', 'instance', 'div', { componentId: 'cp_card' }) as Node,
              ],
            },
          }
        : c,
    );
    expect(findComponentCycle(doc, 'cp_card')).toEqual(['cp_card', 'cp_btn', 'cp_card']);
    const warnings: string[] = [];
    const out = expandInstance(doc, inst(doc, 'in_x'), { warnings });
    expect(warnings.some((w) => /ciclo/.test(w))).toBe(true);
    const loop = find(out, 'in_x/in_cbtn/in_loop')!;
    expect(loop.children[0].text).toBe('Componente ausente');
  });

  it('profundidade maior que 16 vira aviso', () => {
    const doc = fixture([n('in_x', 'instance', 'div', { componentId: 'cp_d0' })]);
    doc.components = Array.from({ length: 20 }, (_, i) => ({
      id: `cp_d${i}`,
      name: `D${i}`,
      props: [],
      variants: [],
      root: n(`el_d${i}`, 'element', 'div', {
        children:
          i < 19 ? [n(`in_d${i}`, 'instance', 'div', { componentId: `cp_d${i + 1}` }) as Node] : [],
      }) as Node,
    }));
    const warnings: string[] = [];
    expandInstance(doc, inst(doc, 'in_x'), { warnings });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/profundidade/);
  });

  it('DAG exponencial (10 níveis × 4 instâncias) vira aviso "Componente grande demais" rápido', () => {
    const doc = fixture([
      n('in_big', 'instance', 'div', { componentId: 'cp_w1' }),
      n('in_ok', 'instance', 'div', { componentId: 'cp_w4' }),
    ]);
    // C1 tem 4 instâncias de C2, C2 tem 4 de C3... C10 é uma folha: ~4^10 nós se expandisse tudo.
    doc.components = Array.from({ length: 10 }, (_, k) => {
      const i = k + 1;
      const kids =
        i < 10
          ? Array.from(
              { length: 4 },
              (_, j) =>
                n(`in_w${i}x${j}`, 'instance', 'div', { componentId: `cp_w${i + 1}` }) as Node,
            )
          : [n('tx_leaf', 'text', 'span', { text: 'folha' }) as Node];
      return {
        id: `cp_w${i}`,
        name: `W${i}`,
        props: [],
        variants: [],
        root: n(`el_w${i}`, 'element', 'div', { children: kids }) as Node,
      };
    });
    expect(expandedSize(doc, 'cp_w10')).toBe(2);
    expect(expandedSize(doc, 'cp_w4')).toBe(9557);
    expect(expandedSize(doc, 'cp_w1')).toBeGreaterThan(MAX_EXPANDED_NODES);
    const t0 = performance.now();
    const warnings: string[] = [];
    const big = expandInstance(doc, inst(doc, 'in_big'), { warnings });
    expect(big.attrs['data-missing-component']).toBe('cp_w1');
    expect(big.children[0]!.text).toBe(TOO_LARGE_COMPONENT_TEXT);
    expect(warnings).toEqual([expect.stringMatching(/in_big: componente "W1" grande demais/)]);
    // Abaixo do limite expande normalmente.
    const ok = expandInstance(doc, inst(doc, 'in_ok'));
    let count = 0;
    const visit = (x: Node): void => {
      count++;
      x.children.forEach(visit);
    };
    visit(ok);
    expect(count).toBe(9557);
    // O documento inteiro também termina rápido.
    const page = expandDocument(doc).pages[0]!.frames[0]!;
    expect(page.children[0]!.children[0]!.text).toBe(TOO_LARGE_COMPONENT_TEXT);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('deep:false mantém as aninhadas como instâncias com os overrides herdados', () => {
    const doc = fixture([
      n('in_c', 'instance', 'div', {
        componentId: 'cp_card',
        overrides: { 'in_cbtn/tx_lbl': { text: 'Y' } },
      }),
    ]);
    const out = expandInstance(doc, inst(doc, 'in_c'), { deep: false });
    const btn = out.children[2];
    expect(btn.type).toBe('instance');
    expect(btn.id).toBe('in_c/in_cbtn');
    expect(btn.overrides).toEqual({ tx_lbl: { text: 'Y' } });
  });
});

describe('expandDocument', () => {
  it('sem instâncias devolve o próprio documento', () => {
    const doc = fixture([n('el_a', 'element', 'div')]);
    expect(expandDocument(doc)).toBe(doc);
  });

  it('compartilhamento estrutural e cache', () => {
    const doc = fixture();
    const out = expandDocument(doc);
    expect(out).not.toBe(doc);
    expect(expandDocument(doc)).toBe(out);
    const frame = out.pages[0].frames[0];
    expect(frame).not.toBe(doc.pages[0].frames[0]);
    // Nó sem instância: mesmo objeto.
    expect(frame.children[3]).toBe(doc.pages[0].frames[0].children[3]);
    expect(JSON.stringify(out.pages)).not.toContain('"instance"');
    expect(JSON.stringify(out.pages)).not.toContain('{{');
    // Cache por instância: a mesma árvore em outra chamada.
    expect(expandNodeTree(doc, doc.pages[0].frames[0]).children[0]).toBe(frame.children[0]);
  });
});
