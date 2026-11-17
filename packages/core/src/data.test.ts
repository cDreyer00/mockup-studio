import { describe, expect, it } from 'vitest';
import { applyOp } from './apply.js';
import { createDocument, createNodeFromTag, findNode } from './document.js';
import {
  applyBindings,
  baseNodeId,
  createRepeaterFrom,
  dataColumns,
  expandRepeater,
  expandRepeaterChildren,
  expandRepeaters,
  getPath,
  guessDataFormat,
  parseCsv,
  parseDataText,
  repeatIndexOf,
  selectDataList,
  templateFields,
} from './data.js';
import { exportHtml } from './export/html.js';
import { parseDocument, serializeDocument } from './schema.js';
import { getTreeSummary } from './summary.js';
import type { Document, Node } from './types.js';

function card(): Node {
  return createNodeFromTag('div', {
    name: 'Card',
    children: [
      createNodeFromTag('h3', { text: '{{nome}}' }),
      createNodeFromTag('p', { text: '{{cargo | Sem cargo}} #{{$number}}' }),
      createNodeFromTag('img', { src: '{{foto}}', attrs: { alt: 'Foto de {{nome}}' } }),
      createNodeFromTag('a', { text: 'Perfil', attrs: { href: '{{url}}' } }),
    ],
  });
}

function repeater(data: unknown[]): Node {
  const list = createNodeFromTag('div', { name: 'Lista', styles: { display: 'grid' } });
  list.children = [card()];
  return createRepeaterFrom(list, data);
}

const people = Array.from({ length: 20 }, (_, i) => ({
  nome: `Pessoa ${i + 1}`,
  cargo: i % 2 === 0 ? 'Design' : '',
  foto: `fotos/p${i + 1}.jpg`,
  url: `https://exemplo.com/p/${i + 1}`,
}));

function docWith(node: Node): Document {
  const doc = createDocument('Teste');
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Desktop',
    styles: { width: '800px' },
  });
  frame.children = [node];
  doc.pages[0]!.frames.push(frame);
  return doc;
}

describe('bindings', () => {
  it('resolve campos, caminhos, padrão e especiais', () => {
    const item = { a: { b: [{ c: 'ok' }] }, n: 0, vazio: '' };
    expect(applyBindings('{{a.b.0.c}}', { item, index: 0 })).toBe('ok');
    expect(applyBindings('{{n}}', { item, index: 0 })).toBe('0');
    expect(applyBindings('{{vazio | "padrão"}}', { item, index: 0 })).toBe('padrão');
    expect(applyBindings('{{ausente}}', { item, index: 0 })).toBe('');
    expect(applyBindings('{{$index}}/{{$number}}', { item, index: 4 })).toBe('4/5');
    expect(applyBindings('{{$item}}', { item: 'texto', index: 0 })).toBe('texto');
    expect(
      applyBindings('{{nome}}', { item: { full: 'Ana' }, index: 0, mapping: { nome: 'full' } }),
    ).toBe('Ana');
    expect(applyBindings('{{obj}}', { item: { obj: { x: 1 } }, index: 0 })).toBe('{"x":1}');
  });

  it('getPath não sobe no protótipo', () => {
    expect(getPath({}, 'constructor')).toBeUndefined();
    expect(getPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('lista os campos do template', () => {
    expect(templateFields([card()])).toEqual(['nome', 'cargo', '$number', 'foto', 'url']);
  });
});

describe('expansão do repetidor', () => {
  it('gera uma cópia do template por item, item 0 com os ids originais', () => {
    const rp = repeater(people);
    const tpl = rp.children[0]!;
    const kids = expandRepeaterChildren(rp);
    expect(kids).toHaveLength(20);
    expect(kids[0]!.id).toBe(tpl.id);
    expect(kids[5]!.id).toBe(`${tpl.id}~5`);
    expect(baseNodeId(kids[5]!.children[0]!.id)).toBe(tpl.children[0]!.id);
    expect(repeatIndexOf(kids[5]!.id)).toBe(5);
    expect(kids[0]!.children[0]!.text).toBe('Pessoa 1');
    expect(kids[1]!.children[1]!.text).toBe('Sem cargo #2');
    expect(kids[2]!.children[2]!.src).toBe('fotos/p3.jpg');
    expect(kids[2]!.children[2]!.attrs.alt).toBe('Foto de Pessoa 3');
    expect(kids[19]!.children[3]!.attrs.href).toBe('https://exemplo.com/p/20');
  });

  it('sem dados mostra o template uma vez', () => {
    const kids = expandRepeaterChildren(repeater([]));
    expect(kids).toHaveLength(1);
    expect(kids[0]!.children[0]!.text).toBe('');
  });

  it('descarta URLs perigosas vindas dos dados', () => {
    const kids = expandRepeaterChildren(
      repeater([{ url: 'javascript:alert(1)', foto: 'javascript:x' }]),
    );
    expect(kids[0]!.children[3]!.attrs.href).toBeUndefined();
    expect(kids[0]!.children[2]!.src).toBeUndefined();
  });

  it('vira elemento comum e sem dados ao expandir', () => {
    const exp = expandRepeater(repeater(people.slice(0, 3)));
    expect(exp.type).toBe('element');
    expect(exp.data).toBeUndefined();
    expect(exp.children).toHaveLength(3);
  });

  it('repetidor aninhado usa os próprios dados e ids únicos', () => {
    const inner = createRepeaterFrom(
      Object.assign(createNodeFromTag('ul'), {
        children: [createNodeFromTag('li', { text: '{{$item}}' })],
      }),
      ['a', 'b'],
    );
    const outer = createRepeaterFrom(
      Object.assign(createNodeFromTag('div'), {
        children: [
          Object.assign(createNodeFromTag('section'), {
            children: [createNodeFromTag('h2', { text: '{{t}}' }), inner],
          }),
        ],
      }),
      [{ t: 'X' }, { t: 'Y' }],
    );
    const root = expandRepeaters(outer);
    const ids: string[] = [];
    const visit = (n: Node): void => {
      ids.push(n.id);
      n.children.forEach(visit);
    };
    visit(root);
    expect(new Set(ids).size).toBe(ids.length);
    const second = root.children[1]!;
    expect(second.children[0]!.text).toBe('Y');
    expect(second.children[1]!.children.map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('o resumo mostra a contagem de itens', () => {
    expect(getTreeSummary(repeater(people), 0)).toMatch(/repeat:20/);
  });

  it('o export html sai com os 20 itens', () => {
    const doc = docWith(repeater(people));
    const html = exportHtml(doc);
    expect(html.match(/Pessoa \d+/g)?.length).toBeGreaterThanOrEqual(20);
    expect(html).toContain('Pessoa 20');
    expect(html).not.toContain('{{nome}}');
  });

  it('recusa "~" no id de nó (reservado aos clones do repetidor)', () => {
    const rp = repeater(people.slice(0, 1));
    const doc = docWith(rp);
    rp.children[0]!.id = `${rp.children[0]!.id}~1`;
    expect(() => parseDocument(serializeDocument(doc))).toThrow(/~/);
  });

  it('serializa e relê data e dataSource', () => {
    const rp = repeater(people.slice(0, 2));
    rp.dataSource = { kind: 'json', path: 'C:/dados/p.json', select: 'items' };
    const doc = parseDocument(serializeDocument(docWith(rp)));
    const back = findNode(doc, rp.id)!.node;
    expect(back.type).toBe('repeater');
    expect(back.data).toHaveLength(2);
    expect(back.dataSource).toEqual({ kind: 'json', path: 'C:/dados/p.json', select: 'items' });
  });
});

describe('op setData', () => {
  it('troca dados e origem e desfaz exatamente', () => {
    const rp = repeater(people.slice(0, 2));
    const doc = docWith(rp);
    const r = applyOp(doc, {
      type: 'setData',
      changes: [{ nodeId: rp.id, data: people, source: { kind: 'inline' } }],
    });
    const after = findNode(r.doc, rp.id)!.node;
    expect(after.data).toHaveLength(20);
    expect(after.dataSource).toEqual({ kind: 'inline' });
    const undone = applyOp(r.doc, r.inverse[0]!);
    const back = findNode(undone.doc, rp.id)!.node;
    expect(back.data).toHaveLength(2);
    expect(back.dataSource).toBeUndefined();
  });

  it('desfaz para sem dados quando o repetidor não tinha a lista', () => {
    const rp = repeater([]);
    delete rp.data;
    const doc = docWith(rp);
    const r = applyOp(doc, { type: 'setData', changes: [{ nodeId: rp.id, data: people }] });
    expect(findNode(r.doc, rp.id)!.node.data).toHaveLength(20);
    const undone = applyOp(r.doc, r.inverse[0]!);
    const back = findNode(undone.doc, rp.id)!.node;
    expect('data' in back).toBe(false);
    expect(back).toEqual(findNode(doc, rp.id)!.node);
  });

  it('recusa nó que não é repetidor e dados acima do limite', () => {
    const rp = repeater([]);
    const doc = docWith(rp);
    const other = rp.children[0]!.id;
    expect(() => applyOp(doc, { type: 'setData', changes: [{ nodeId: other, data: [] }] })).toThrow(
      /não é um repetidor/,
    );
    expect(() =>
      applyOp(doc, {
        type: 'setData',
        changes: [{ nodeId: rp.id, data: new Array(1001).fill({}) }],
      }),
    ).toThrow(/1000/);
  });
});

describe('leitura de dados', () => {
  it('CSV com aspas, quebras e separador detectado', () => {
    const csv = 'nome;descrição\n"Ana; Lima";"linha 1\nlinha 2"\nBeto;"com ""aspas"""\n';
    expect(parseCsv(csv)).toEqual([
      { nome: 'Ana; Lima', descrição: 'linha 1\nlinha 2' },
      { nome: 'Beto', descrição: 'com "aspas"' },
    ]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([{ a: '1', b: '2' }]);
    expect(parseCsv('\uFEFFa\tb\n1\t2')).toEqual([{ a: '1', b: '2' }]);
  });

  it('acha a lista dentro do JSON', () => {
    expect(selectDataList({ data: { items: [1, 2] } }, 'data.items')).toEqual([1, 2]);
    expect(selectDataList({ total: 2, results: [1, 2] })).toEqual([1, 2]);
    expect(selectDataList({ meta: { rows: [3] } })).toEqual([3]);
    expect(selectDataList({ a: 1 })).toEqual([{ a: 1 }]);
    expect(() => selectDataList({ a: 1 }, 'a')).toThrow(/não aponta para uma lista/);
  });

  it('parseDataText aplica limite e reporta JSON inválido', () => {
    expect(parseDataText('[1,2,3]', 'json', { limit: 2 })).toEqual([1, 2]);
    expect(() => parseDataText('{', 'json')).toThrow(/JSON inválido/);
  });

  it('adivinha o formato e as colunas', () => {
    expect(guessDataFormat('C:/x/dados.CSV')).toBe('csv');
    expect(guessDataFormat('text/csv')).toBe('csv');
    expect(guessDataFormat('https://api.x.com/users?page=1')).toBe('json');
    expect(dataColumns([{ a: 1 }, { b: 2, a: 3 }, 'x'])).toEqual(['a', 'b', '$item']);
  });
});
