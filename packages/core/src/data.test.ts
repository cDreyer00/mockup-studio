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
      createNodeFromTag('h3', { text: '{{name}}' }),
      createNodeFromTag('p', { text: '{{role | No role}} #{{$number}}' }),
      createNodeFromTag('img', { src: '{{photo}}', attrs: { alt: 'Photo of {{name}}' } }),
      createNodeFromTag('a', { text: 'Profile', attrs: { href: '{{url}}' } }),
    ],
  });
}

function repeater(data: unknown[]): Node {
  const list = createNodeFromTag('div', { name: 'List', styles: { display: 'grid' } });
  list.children = [card()];
  return createRepeaterFrom(list, data);
}

const people = Array.from({ length: 20 }, (_, i) => ({
  name: `Person ${i + 1}`,
  role: i % 2 === 0 ? 'Design' : '',
  photo: `photos/p${i + 1}.jpg`,
  url: `https://example.com/p/${i + 1}`,
}));

function docWith(node: Node): Document {
  const doc = createDocument('Test');
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
  it('resolves fields, paths, defaults and specials', () => {
    const item = { a: { b: [{ c: 'ok' }] }, n: 0, empty: '' };
    expect(applyBindings('{{a.b.0.c}}', { item, index: 0 })).toBe('ok');
    expect(applyBindings('{{n}}', { item, index: 0 })).toBe('0');
    expect(applyBindings('{{empty | "default"}}', { item, index: 0 })).toBe('default');
    expect(applyBindings('{{missing}}', { item, index: 0 })).toBe('');
    expect(applyBindings('{{$index}}/{{$number}}', { item, index: 4 })).toBe('4/5');
    expect(applyBindings('{{$item}}', { item: 'text', index: 0 })).toBe('text');
    expect(
      applyBindings('{{name}}', { item: { full: 'Ana' }, index: 0, mapping: { name: 'full' } }),
    ).toBe('Ana');
    expect(applyBindings('{{obj}}', { item: { obj: { x: 1 } }, index: 0 })).toBe('{"x":1}');
  });

  it('getPath does not climb the prototype', () => {
    expect(getPath({}, 'constructor')).toBeUndefined();
    expect(getPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('lists the template fields', () => {
    expect(templateFields([card()])).toEqual(['name', 'role', '$number', 'photo', 'url']);
  });
});

describe('repeater expansion', () => {
  it('generates one template copy per item, item 0 with the original ids', () => {
    const rp = repeater(people);
    const tpl = rp.children[0]!;
    const kids = expandRepeaterChildren(rp);
    expect(kids).toHaveLength(20);
    expect(kids[0]!.id).toBe(tpl.id);
    expect(kids[5]!.id).toBe(`${tpl.id}~5`);
    expect(baseNodeId(kids[5]!.children[0]!.id)).toBe(tpl.children[0]!.id);
    expect(repeatIndexOf(kids[5]!.id)).toBe(5);
    expect(kids[0]!.children[0]!.text).toBe('Person 1');
    expect(kids[1]!.children[1]!.text).toBe('No role #2');
    expect(kids[2]!.children[2]!.src).toBe('photos/p3.jpg');
    expect(kids[2]!.children[2]!.attrs.alt).toBe('Photo of Person 3');
    expect(kids[19]!.children[3]!.attrs.href).toBe('https://example.com/p/20');
  });

  it('without data shows the template once', () => {
    const kids = expandRepeaterChildren(repeater([]));
    expect(kids).toHaveLength(1);
    expect(kids[0]!.children[0]!.text).toBe('');
  });

  it('drops dangerous URLs coming from the data', () => {
    const kids = expandRepeaterChildren(
      repeater([{ url: 'javascript:alert(1)', photo: 'javascript:x' }]),
    );
    expect(kids[0]!.children[3]!.attrs.href).toBeUndefined();
    expect(kids[0]!.children[2]!.src).toBeUndefined();
  });

  it('becomes a plain element without data when expanded', () => {
    const exp = expandRepeater(repeater(people.slice(0, 3)));
    expect(exp.type).toBe('element');
    expect(exp.data).toBeUndefined();
    expect(exp.children).toHaveLength(3);
  });

  it('nested repeater uses its own data and unique ids', () => {
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

  it('the summary shows the item count', () => {
    expect(getTreeSummary(repeater(people), 0)).toMatch(/repeat:20/);
  });

  it('the html export contains all 20 items', () => {
    const doc = docWith(repeater(people));
    const html = exportHtml(doc);
    expect(html.match(/Person \d+/g)?.length).toBeGreaterThanOrEqual(20);
    expect(html).toContain('Person 20');
    expect(html).not.toContain('{{name}}');
  });

  it('rejects "~" in a node id (reserved for repeater clones)', () => {
    const rp = repeater(people.slice(0, 1));
    const doc = docWith(rp);
    rp.children[0]!.id = `${rp.children[0]!.id}~1`;
    expect(() => parseDocument(serializeDocument(doc))).toThrow(/~/);
  });

  it('serializes and re-reads data and dataSource', () => {
    const rp = repeater(people.slice(0, 2));
    rp.dataSource = { kind: 'json', path: 'C:/data/p.json', select: 'items' };
    const doc = parseDocument(serializeDocument(docWith(rp)));
    const back = findNode(doc, rp.id)!.node;
    expect(back.type).toBe('repeater');
    expect(back.data).toHaveLength(2);
    expect(back.dataSource).toEqual({ kind: 'json', path: 'C:/data/p.json', select: 'items' });
  });
});

describe('op setData', () => {
  it('swaps data and source and undoes exactly', () => {
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

  it('undoes to no data when the repeater had no list', () => {
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

  it('rejects a non-repeater node and data above the limit', () => {
    const rp = repeater([]);
    const doc = docWith(rp);
    const other = rp.children[0]!.id;
    expect(() => applyOp(doc, { type: 'setData', changes: [{ nodeId: other, data: [] }] })).toThrow(
      /is not a repeater/,
    );
    expect(() =>
      applyOp(doc, {
        type: 'setData',
        changes: [{ nodeId: rp.id, data: new Array(1001).fill({}) }],
      }),
    ).toThrow(/1000/);
  });
});

describe('data reading', () => {
  it('CSV with quotes, line breaks and detected delimiter', () => {
    const csv = 'name;description\n"Ana; Lima";"line 1\nline 2"\nBeto;"with ""quotes"""\n';
    expect(parseCsv(csv)).toEqual([
      { name: 'Ana; Lima', description: 'line 1\nline 2' },
      { name: 'Beto', description: 'with "quotes"' },
    ]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([{ a: '1', b: '2' }]);
    expect(parseCsv('\uFEFFa\tb\n1\t2')).toEqual([{ a: '1', b: '2' }]);
  });

  it('finds the list inside the JSON', () => {
    expect(selectDataList({ data: { items: [1, 2] } }, 'data.items')).toEqual([1, 2]);
    expect(selectDataList({ total: 2, results: [1, 2] })).toEqual([1, 2]);
    expect(selectDataList({ meta: { rows: [3] } })).toEqual([3]);
    expect(selectDataList({ a: 1 })).toEqual([{ a: 1 }]);
    expect(() => selectDataList({ a: 1 }, 'a')).toThrow(/does not point to a list/);
  });

  it('parseDataText applies the limit and reports invalid JSON', () => {
    expect(parseDataText('[1,2,3]', 'json', { limit: 2 })).toEqual([1, 2]);
    expect(() => parseDataText('{', 'json')).toThrow(/Invalid JSON/);
  });

  it('guesses the format and the columns', () => {
    expect(guessDataFormat('C:/x/data.CSV')).toBe('csv');
    expect(guessDataFormat('text/csv')).toBe('csv');
    expect(guessDataFormat('https://api.x.com/users?page=1')).toBe('json');
    expect(dataColumns([{ a: 1 }, { b: 2, a: 3 }, 'x'])).toEqual(['a', 'b', '$item']);
  });
});
