/**
 * Componentes com os nós e as ops das fases 6 a 8: repetidor (`setData`), vetor (`setVector`) e
 * mídia (`setMedia`) dentro de um principal, editados pela instância (ids virtuais viram
 * overrides), pelo principal e por variantes; leitura de arquivo e exportadores.
 */
import { describe, expect, it } from 'vitest';
import { applyOp } from '../apply.js';
import { findNode } from '../document.js';
import { exportHtml } from '../export/html.js';
import { parseDocument, serializeDocument } from '../schema.js';
import type { Document, Node, Vector } from '../types.js';
import { expandDocument, getComponent } from './expand.js';
import { normalizeOverride } from './ops.js';

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

const SQUARE: Vector = {
  viewBox: { x: 0, y: 0, width: 24, height: 24 },
  paths: [{ id: 'p1', d: 'M0 0H24V24H0Z', fill: '#ff0000' }],
};
const CIRCLE: Vector = {
  viewBox: { x: 0, y: 0, width: 24, height: 24 },
  paths: [{ id: 'p1', d: 'M12 0A12 12 0 1 1 12 24A12 12 0 1 1 12 0Z', fill: '#00ff00' }],
};

function fixture(): Document {
  return parseDocument({
    version: 1,
    id: 'doc_f',
    name: 'F',
    tokens: {},
    fonts: [],
    meta: { createdAt: 'x', updatedAt: 'x' },
    components: [
      {
        id: 'cp_hero',
        name: 'Hero',
        props: [{ name: 'tone', type: 'enum', default: 'calm', options: ['calm', 'loud'] }],
        root: n('el_hero', 'element', 'section', {
          style: { position: 'relative', width: '400px', height: '300px' },
          children: [
            n('fx_bg0001', 'effect', 'canvas', {
              effect: { kind: 'mesh-gradient', params: { speed: 1 } },
              style: { position: 'absolute', inset: '0' },
            }),
            n('sv_icon001', 'svg', 'svg', { vector: SQUARE, style: { width: '24px' } }),
            n('vd_clip001', 'video', 'video', { video: { src: 'clips/a.mp4', muted: true } }),
            n('rp_list001', 'repeater', 'ul', {
              data: [{ nome: 'Ana' }, { nome: 'Bia' }],
              children: [n('tx_item001', 'text', 'li', { text: '{{nome}}' })] as Node[],
            }),
          ] as Node[],
        }),
        variants: [
          {
            when: { tone: 'loud' },
            overrides: { fx_bg0001: { effect: { kind: 'grain', params: {} } } },
          },
        ],
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
              n('in_a', 'instance', 'section', { componentId: 'cp_hero' }),
              n('in_b', 'instance', 'section', { componentId: 'cp_hero' }),
            ] as Node[],
          }),
        ],
      },
    ],
  });
}

const view = (doc: Document, id: string): Node => {
  const p = findNode(expandDocument(doc), id);
  if (!p) throw new Error(`sem ${id}`);
  return p.node;
};

describe('componentes × repetidor, vetor e mídia', () => {
  it('setMedia num efeito da instância vira override; a outra instância e o principal não mudam', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMedia',
      changes: [{ nodeId: 'in_a/fx_bg0001', effect: { kind: 'grain', params: { amount: 0.4 } } }],
    });
    const inst = findNode(r.doc, 'in_a')!.node;
    expect(inst.overrides).toEqual({
      fx_bg0001: { effect: { kind: 'grain', params: { amount: 0.4 } } },
    });
    expect(view(r.doc, 'in_a/fx_bg0001').effect?.kind).toBe('grain');
    expect(view(r.doc, 'in_b/fx_bg0001').effect?.kind).toBe('mesh-gradient');
    expect(getComponent(r.doc, 'cp_hero')!.root.children[0]!.effect?.kind).toBe('mesh-gradient');
    // o inverso desfaz exatamente
    const back = applyOp(r.doc, r.inverse[0]!);
    expect(findNode(back.doc, 'in_a')!.node.overrides).toBeUndefined();
    expect(view(back.doc, 'in_a/fx_bg0001').effect?.kind).toBe('mesh-gradient');
  });

  it('setMedia com o campo errado ou efeito desconhecido é recusado no id virtual', () => {
    const doc = fixture();
    expect(() =>
      applyOp(doc, {
        type: 'setMedia',
        changes: [{ nodeId: 'in_a/fx_bg0001', video: { src: 'x.mp4' } }],
      }),
    ).toThrow(/video só vale em nós video/);
    expect(() =>
      applyOp(doc, {
        type: 'setMedia',
        changes: [{ nodeId: 'in_a/fx_bg0001', effect: { kind: 'nao-existe', params: {} } }],
      }),
    ).toThrow(/Efeito desconhecido/);
  });

  it('setMedia em vídeo e a variante do efeito', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMedia',
      changes: [{ nodeId: 'in_b/vd_clip001', video: { src: 'clips/b.mp4', loop: true } }],
    });
    expect(view(r.doc, 'in_b/vd_clip001').video).toEqual({ src: 'clips/b.mp4', loop: true });
    expect(view(r.doc, 'in_a/vd_clip001').video?.src).toBe('clips/a.mp4');
    // variante loud troca o efeito; o override da instância vence a variante
    const loud = applyOp(r.doc, {
      type: 'setInstanceProps',
      changes: [{ nodeId: 'in_a', set: { tone: 'loud' } }],
    });
    expect(view(loud.doc, 'in_a/fx_bg0001').effect?.kind).toBe('grain');
    const own = applyOp(loud.doc, {
      type: 'setMedia',
      changes: [
        { nodeId: 'in_a/fx_bg0001', effect: { kind: 'mesh-gradient', params: { speed: 3 } } },
      ],
    });
    expect(view(own.doc, 'in_a/fx_bg0001').effect).toEqual({
      kind: 'mesh-gradient',
      params: { speed: 3 },
    });
  });

  it('setVector no svg da instância grava vetor e markup gerado; vector null volta ao principal', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setVector',
      changes: [{ nodeId: 'in_a/sv_icon001', vector: CIRCLE }],
    });
    const ov = findNode(r.doc, 'in_a')!.node.overrides!.sv_icon001!;
    expect(ov.vector?.paths[0]!.fill).toBe('#00ff00');
    expect(ov.svg).toContain('#00ff00');
    const v = view(r.doc, 'in_a/sv_icon001');
    expect(v.vector?.paths[0]!.fill).toBe('#00ff00');
    expect(v.svg).toContain('#00ff00');
    expect(view(r.doc, 'in_b/sv_icon001').svg).toContain('#ff0000');

    const reset = applyOp(r.doc, {
      type: 'setVector',
      changes: [{ nodeId: 'in_a/sv_icon001', vector: null }],
    });
    expect(findNode(reset.doc, 'in_a')!.node.overrides).toBeUndefined();
    expect(view(reset.doc, 'in_a/sv_icon001').svg).toContain('#ff0000');
  });

  it('setSvg sem vetor na instância descarta o vetor do principal na visão', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setSvg',
      changes: [
        {
          nodeId: 'in_a/sv_icon001',
          svg: '<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="#0000ff"/></svg>',
        },
      ],
    });
    const v = view(r.doc, 'in_a/sv_icon001');
    expect(v.svg).toContain('#0000ff');
    expect(v.vector).toBeUndefined();
    expect(view(r.doc, 'in_b/sv_icon001').vector).toBeDefined();
  });

  it('setData no repetidor da instância troca os itens (lista vazia é um valor)', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setData',
      changes: [{ nodeId: 'in_a/rp_list001', data: [{ nome: 'Caio' }] }],
    });
    expect(view(r.doc, 'in_a/rp_list001').data).toEqual([{ nome: 'Caio' }]);
    expect(view(r.doc, 'in_b/rp_list001').data).toHaveLength(2);
    const empty = applyOp(r.doc, {
      type: 'setData',
      changes: [{ nodeId: 'in_a/rp_list001', data: [] }],
    });
    expect(findNode(empty.doc, 'in_a')!.node.overrides).toEqual({ rp_list001: { data: [] } });
    expect(view(empty.doc, 'in_a/rp_list001').data).toEqual([]);
    // o undo restaura o override anterior
    const back = applyOp(empty.doc, empty.inverse[0]!);
    expect(view(back.doc, 'in_a/rp_list001').data).toEqual([{ nome: 'Caio' }]);
    // fonte de dados também é sobrescrevível; null remove
    const src = applyOp(r.doc, {
      type: 'setData',
      changes: [{ nodeId: 'in_a/rp_list001', source: { kind: 'inline' } }],
    });
    expect(view(src.doc, 'in_a/rp_list001').dataSource).toEqual({ kind: 'inline' });
    const noSrc = applyOp(src.doc, {
      type: 'setData',
      changes: [{ nodeId: 'in_a/rp_list001', source: null }],
    });
    expect(view(noSrc.doc, 'in_a/rp_list001').dataSource).toBeUndefined();
  });

  it('setData em nó que não é repetidor é recusado no id virtual', () => {
    expect(() =>
      applyOp(fixture(), {
        type: 'setData',
        changes: [{ nodeId: 'in_a/vd_clip001', data: [] }],
      }),
    ).toThrow(/não é um repetidor/);
  });

  it('as ops em nós do principal editam o principal (todas as instâncias mudam)', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setMedia',
      changes: [{ nodeId: 'fx_bg0001', effect: { kind: 'grain', params: {} } }],
    });
    expect(getComponent(r.doc, 'cp_hero')!.root.children[0]!.effect?.kind).toBe('grain');
    expect(view(r.doc, 'in_a/fx_bg0001').effect?.kind).toBe('grain');
    expect(view(r.doc, 'in_b/fx_bg0001').effect?.kind).toBe('grain');
    const d2 = applyOp(r.doc, {
      type: 'setData',
      changes: [{ nodeId: 'rp_list001', data: [{ nome: 'Zé' }] }],
    });
    expect(view(d2.doc, 'in_b/rp_list001').data).toEqual([{ nome: 'Zé' }]);
    const d3 = applyOp(d2.doc, {
      type: 'setVector',
      changes: [{ nodeId: 'sv_icon001', vector: CIRCLE }],
    });
    expect(view(d3.doc, 'in_a/sv_icon001').svg).toContain('#00ff00');
    // undo de cada passo
    expect(
      getComponent(applyOp(d3.doc, d3.inverse[0]!).doc, 'cp_hero')!.root.children[1]!.vector,
    ).toEqual(SQUARE);
  });

  it('os overrides novos sobrevivem a salvar e reabrir; inválidos são descartados na leitura', () => {
    let doc = fixture();
    doc = applyOp(doc, {
      type: 'setMedia',
      changes: [{ nodeId: 'in_a/fx_bg0001', effect: { kind: 'grain', params: { amount: 1 } } }],
    }).doc;
    doc = applyOp(doc, {
      type: 'setData',
      changes: [{ nodeId: 'in_a/rp_list001', data: [] }],
    }).doc;
    doc = applyOp(doc, {
      type: 'setVector',
      changes: [{ nodeId: 'in_a/sv_icon001', vector: CIRCLE }],
    }).doc;
    const again = parseDocument(JSON.parse(serializeDocument(doc)));
    expect(findNode(again, 'in_a')!.node.overrides).toEqual(findNode(doc, 'in_a')!.node.overrides);

    const raw = JSON.parse(serializeDocument(doc));
    raw.pages[0].frames[0].children[0].overrides.fx_bg0001.video = { src: 'javascript:x' };
    expect(() => parseDocument(raw)).toThrow();
    raw.pages[0].frames[0].children[0].overrides.fx_bg0001 = { vector: { lixo: true } };
    const loose = parseDocument(raw);
    expect(findNode(loose, 'in_a')!.node.overrides!.fx_bg0001).toBeUndefined();
  });

  it('normalizeOverride valida os campos novos com as regras das ops', () => {
    expect(() => normalizeOverride({ video: { src: 'javascript:alert(1)' } })).toThrow(/video/);
    expect(() => normalizeOverride({ effect: { kind: 'nao-existe', params: {} } })).toThrow(
      /desconhecido/,
    );
    expect(normalizeOverride({ data: [] })).toEqual({ data: [] });
  });

  it('o export HTML expande a instância com o efeito, o vetor e os itens sobrescritos', () => {
    let doc = fixture();
    doc = applyOp(doc, {
      type: 'setMedia',
      changes: [{ nodeId: 'in_a/fx_bg0001', effect: { kind: 'grain', params: {} } }],
    }).doc;
    doc = applyOp(doc, {
      type: 'setData',
      changes: [{ nodeId: 'in_a/rp_list001', data: [{ nome: 'Caio' }, { nome: 'Duda' }] }],
    }).doc;
    doc = applyOp(doc, {
      type: 'setVector',
      changes: [{ nodeId: 'in_a/sv_icon001', vector: CIRCLE }],
    }).doc;
    const html = exportHtml(doc, { nodeIds: ['in_a'] });
    expect(html).toContain('"kind":"grain"');
    expect(html).toContain('Caio');
    expect(html).toContain('Duda');
    expect(html).not.toContain('Ana');
    expect(html).toContain('#00ff00');
    const other = exportHtml(doc, { nodeIds: ['in_b'] });
    expect(other).toContain('"kind":"mesh-gradient"');
    expect(other).toContain('Ana');
  });
});
