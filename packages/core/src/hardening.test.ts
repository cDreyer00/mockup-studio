import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from './apply.js';
import { createDocument, createNode, createNodeFromTag, findNode } from './document.js';
import { htmlToNodes, nodesToHtml } from './html.js';
import { History } from './history.js';
import { parseOp } from './ops.schema.js';
import { parseDocument, validateDocument } from './schema.js';
import { sanitizeSvg } from './svg.js';
import { isValidTag, normalizeTag } from './tags.js';
import type { Op } from './ops.js';
import type { Document, Node } from './types.js';

function base(): { doc: Document; frameId: string } {
  const doc = createDocument('t', { id: 'doc_hard0001' });
  const frame = createNodeFromTag('div', { isRoot: true });
  frame.id = 'fr_hard0001';
  doc.pages[0]!.frames.push(frame);
  return { doc, frameId: frame.id };
}

const mk = (id: string, tag: string, extra: Partial<Node> = {}): Node => {
  const n = createNodeFromTag(tag, {});
  n.id = id;
  return Object.assign(n, extra);
};

describe('tags (item 1)', () => {
  it('normalizeTag/isValidTag', () => {
    expect(normalizeTag('  DIV ')).toBe('div');
    expect(isValidTag('my_tag')).toBe(false);
    expect(isValidTag('SCRIPT')).toBe(false);
    expect(() => normalizeTag('SCRIPT')).toThrow(/Invalid tag/);
    expect(() => normalizeTag('a b')).toThrow(/Invalid tag/);
  });

  it('createNode throws for a blocked tag in any case', () => {
    expect(() => createNode({ tag: 'SCRIPT' })).toThrow(/Invalid tag/);
    expect(createNode({ tag: 'DIV' }).tag).toBe('div');
  });

  it('parseDocument rejects a Script tag', () => {
    const { doc } = base();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.pages[0].frames[0].tag = 'Script';
    expect(() => parseDocument(raw)).toThrow(/tag blocked/);
    raw.pages[0].frames[0].tag = 'a_b';
    expect(() => parseDocument(raw)).toThrow(/invalid tag/);
  });

  it('htmlToNodes skips iframe/object/embed/base and tags outside the regex', () => {
    const ns = htmlToNodes('<iframe src=x></iframe><p>a</p><my_tag>x</my_tag><base href="/">');
    expect(ns.map((n) => n.tag)).toEqual(['p']);
  });
});

describe('dangerous URLs in attributes (htmlToNodes)', () => {
  it('drops href/src/action/formaction with javascript: or non-image data: and srcdoc', () => {
    const [root] = htmlToNodes(
      '<div><a href=" JavaScript:alert(1)" title="t">x</a><form action="javascript:1"><button formaction="data:text/html,1">b</button></form>' +
        '<img src="data:text/html,x" alt="a"/><img src="data:image/png;base64,AA" alt="b"/><a href="https://ok.dev">ok</a></div>',
    );
    const flat = JSON.stringify(root);
    expect(flat).not.toMatch(/javascript|text\/html/i);
    expect(flat).toContain('"title":"t"');
    expect(flat).toContain('https://ok.dev');
    expect(flat).toContain('data:image/png;base64,AA');
  });
});

describe('sanitizeSvg (item 2)', () => {
  it('removes script, on* and foreignObject', () => {
    const [svg] = htmlToNodes(
      '<svg onload="alert(1)"><script>alert(2)</script><circle onclick="x()"/></svg>',
    );
    expect(svg!.svg).not.toMatch(/\son\w+=|<script/i);
    expect(svg!.svg).toContain('<circle');
    expect(sanitizeSvg('<svg><foreignObject><div/></foreignObject><g/></svg>')).toBe(
      '<svg><g/></svg>',
    );
    expect(sanitizeSvg('<p>nothing</p>')).toBe('');
  });

  it('dangerous href is removed; data:image is kept; viewBox preserved', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 1 1"><a xlink:href=" JaVa\tscript:alert(1)"/><a href="data:text/html,x"/>' +
        '<image href="data:image/png;base64,AAAA"/></svg>',
    );
    expect(out).toContain('viewBox="0 0 1 1"');
    expect(out).not.toMatch(/javascript|text\/html/i);
    expect(out).toContain('href="data:image/png;base64,AAAA"');
  });

  it('removes elements outside the allowlist (escape from the SVG context in the exported HTML)', () => {
    const out = sanitizeSvg(
      '<svg><p/><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>' +
        '<embed src="data:text/html,x"/><style>body{display:none}</style><svg:script>1</svg:script>' +
        '<animate attributeName="href" to="javascript:alert(1)"/><set attributeName="href" to="x"/>' +
        '<g><rect width="1" height="1"/><text><tspan>ok</tspan></text></g>' +
        '<defs><linearGradient id="g"><stop offset="0"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs></svg>',
    );
    expect(out).not.toMatch(/<p|iframe|embed|<style|script|animate|<set|srcdoc|javascript/i);
    expect(out).toContain('<rect width="1" height="1"/>');
    expect(out).toContain('<tspan>ok</tspan>');
    expect(out).toContain('<linearGradient id="g"><stop offset="0"/></linearGradient>');
    expect(out).toContain('<feGaussianBlur stdDeviation="2"/>');
  });

  it('removes comments, CDATA and directives (comment closed by --!> in the HTML parser)', () => {
    const out = sanitizeSvg('<svg><!-- --!><img src=x onerror=alert(1)> --><rect/></svg>');
    expect(out).not.toMatch(/onerror|<!--|<img/i);
    expect(out).toBe('<svg><rect/></svg>');
    const cdata = sanitizeSvg(
      '<svg><![CDATA[<img onerror=1>]]><?x <img onerror=2>?><text>ok</text></svg>',
    );
    expect(cdata).not.toMatch(/onerror|CDATA|<\?x/i);
    expect(cdata).toContain('<text>ok</text>');
  });

  it('use only accepts href to a fragment', () => {
    const out = sanitizeSvg(
      '<svg><use href="#ok"/><use href="data:image/svg+xml,x"/><use xlink:href="https://a.dev/x.svg#y"/></svg>',
    );
    expect(out).toContain('<use href="#ok"/>');
    expect(out).not.toMatch(/data:|https:/);
  });

  it('href with an arbitrary namespace prefix is treated as href', () => {
    const out = sanitizeSvg(
      '<svg xmlns:x="http://www.w3.org/1999/xlink"><a x:href="javascript:alert(1)">a</a>' +
        '<use x:href="#ok"/></svg>',
    );
    expect(out).not.toMatch(/javascript/i);
    expect(out).toContain('x:href="#ok"');
    expect(out).toContain('xmlns:x=');
  });

  it('NodeSchema sanitizes the svg field', () => {
    const { doc } = base();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.pages[0].frames[0].children = [
      {
        id: 's1',
        type: 'svg',
        name: 's',
        tag: 'svg',
        svg: '<svg onload="x()"><script>1</script></svg>',
      },
    ];
    const parsed = parseDocument(raw);
    expect(parsed.pages[0]!.frames[0]!.children[0]!.svg).toBe('<svg/>');
  });
});

describe('OpSchema / parseOp (item 3)', () => {
  it('createNode with an incomplete node throws mentioning the missing field', () => {
    const { doc, frameId } = base();
    expect(() =>
      applyOp(doc, { type: 'createNode', parentId: frameId, node: { id: 'x' } } as never),
    ).toThrow(/Invalid operation: node\.type/);
  });

  it('unknown type', () => {
    const { doc } = base();
    expect(() => applyOp(doc, { type: 'xyz' } as never)).toThrow(/Invalid operation/);
    expect(() => parseOp(null)).toThrow(/Invalid operation/);
  });

  it('defaults/sanitization apply on createNode; document stays valid (including undo/redo)', () => {
    const { doc, frameId } = base();
    const svg = mk('sv_hard0001', 'svg', { svg: '<svg onclick="x()"><circle/></svg>' });
    const h = new History(doc);
    h.apply([
      { type: 'createNode', parentId: frameId, node: svg },
      {
        type: 'createNode',
        parentId: frameId,
        node: { id: 'el_hard0002', type: 'element', name: 'd', tag: 'DIV' } as never,
      },
      { type: 'setText', changes: [{ nodeId: 'el_hard0002', text: 'hi' }] },
      { type: 'setPosition', changes: [{ nodeId: 'el_hard0002', position: { x: 1, y: 2 } }] },
      { type: 'duplicateNodes', nodeIds: ['el_hard0002'] },
      { type: 'setTokens', set: { '--a': '1' } },
    ]);
    expect(findNode(h.doc, 'sv_hard0001')!.node.svg).toBe('<svg><circle/></svg>');
    expect(findNode(h.doc, 'el_hard0002')!.node.tag).toBe('div');
    expect(validateDocument(h.doc).ok).toBe(true);
    h.undo();
    expect(validateDocument(h.doc).ok).toBe(true);
    h.redo();
    expect(validateDocument(h.doc).ok).toBe(true);
  });
});

describe('exact inverses (item 4)', () => {
  it('setText on a node without text: undo removes the field', () => {
    const { doc, frameId } = base();
    const r = applyOp(doc, { type: 'setText', changes: [{ nodeId: frameId, text: 'x' }] });
    expect(findNode(r.doc, frameId)!.node.text).toBe('x');
    const back = applyOps(r.doc, r.inverse).doc;
    expect('text' in findNode(back, frameId)!.node).toBe(false);
  });

  it('setPosition on a node without position: undo removes the field; null removes', () => {
    const { doc, frameId } = base();
    const r = applyOp(doc, {
      type: 'setPosition',
      changes: [{ nodeId: frameId, position: { x: 5, y: 6 } }],
    });
    const back = applyOps(r.doc, r.inverse).doc;
    expect('position' in findNode(back, frameId)!.node).toBe(false);
    const gone = applyOp(r.doc, {
      type: 'setPosition',
      changes: [{ nodeId: frameId, position: null }],
    }).doc;
    expect('position' in findNode(gone, frameId)!.node).toBe(false);
  });
});

describe('duplicateNodes with ancestor + descendant (item 5)', () => {
  it('duplicates only the top', () => {
    const { doc, frameId } = base();
    const child = mk('el_hard0003', 'span');
    const parent = mk('el_hard0004', 'section', { children: [child] });
    const d1 = applyOp(doc, { type: 'createNode', parentId: frameId, node: parent }).doc;
    const r = applyOp(d1, { type: 'duplicateNodes', nodeIds: ['el_hard0003', 'el_hard0004'] });
    expect((r.result!.nodeIds as string[]).length).toBe(1);
    const idMap = r.result!.idMap as Record<string, string>;
    expect(Object.keys(idMap).sort()).toEqual(['el_hard0003', 'el_hard0004']);
    expect(findNode(r.doc, frameId)!.node.children).toHaveLength(2);
  });
});

describe('whitespace in mixed text (item 6)', () => {
  it('rules', () => {
    const [p] = htmlToNodes('<p>Hello <b>world</b> end</p>');
    expect(p!.children.map((c) => c.text)).toEqual(['Hello ', 'world', ' end']);
    expect(htmlToNodes('<p>\n  Text\n</p>')[0]!.text).toBe('Text');
    expect(htmlToNodes('<span>Hello </span>')[0]!.text).toBe('Hello ');
  });

  it('round-trip stable across two passes', () => {
    const h1 = nodesToHtml(htmlToNodes('<p>Hello <b>world</b> end</p>')).html;
    expect(h1).toContain('Hello </span>');
    expect(h1).toContain('<span> end');
    expect(nodesToHtml(htmlToNodes(h1)).html).toBe(h1);
  });
});

describe('escaping (item 7)', () => {
  it('malicious attribute name throws on output', () => {
    const n = mk('el_hard0005', 'div', { attrs: { 'x" onmouseover="alert(1)': '1' } });
    expect(() => nodesToHtml(n)).toThrow(/Invalid attribute name/);
  });

  it('single quotes escaped in attribute values', () => {
    const n = mk('el_hard0006', 'div', { attrs: { title: "a'b" } });
    expect(nodesToHtml(n).html).toContain('title="a&#39;b"');
  });

  it('setAttrs rejects on* and invalid names', () => {
    const { doc, frameId } = base();
    const set = (k: string): Op => ({
      type: 'setAttrs',
      changes: [{ nodeId: frameId, set: { [k]: '1' } }],
    });
    expect(() => applyOp(doc, set('onclick'))).toThrow(/on\*/);
    expect(() => applyOp(doc, set('OnLoad'))).toThrow(/on\*/);
    expect(() => applyOp(doc, set('a b'))).toThrow(/Invalid attribute/);
  });

  it('htmlToNodes drops on* and invalid attributes', () => {
    const [p] = htmlToNodes('<p onclick="x()" title="t" data-ok="1">a</p>');
    expect(p!.attrs).toEqual({ title: 't', 'data-ok': '1' });
  });

  it('NodeSchema validates attrs keys', () => {
    const { doc } = base();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.pages[0].frames[0].attrs = { 'a b': '1' };
    expect(() => parseDocument(raw)).toThrow(/attribute/);
  });

  it('</style> does not escape <style> (classes and tokens)', () => {
    const n = mk('el_hard0007', 'div', { style: { content: '"</style><script>"' } });
    const { css } = nodesToHtml(n, { mode: 'classes' });
    expect(css).not.toContain('</style>');
    expect(css).toContain('<\\/style>');
    // defense in depth: even if the value reaches the exporter, `</style` does not escape
    const { doc, frameId } = base();
    const created = applyOp(doc, { type: 'createNode', parentId: frameId, node: n }).doc;
    expect(JSON.stringify(created)).not.toContain('</style>');
    expect(() =>
      applyOp(created, {
        type: 'updateStyles',
        nodeIds: [frameId],
        styles: { content: '"</style>"' },
      }),
    ).toThrow(/Invalid CSS value/);
    expect(() =>
      applyOp(doc, { type: 'setTokens', set: { '--x': '</style><script>alert(1)</script>' } }),
    ).toThrow(/invalid value/);
  });

  it('invalid token names are rejected', () => {
    const { doc } = base();
    expect(() => applyOp(doc, { type: 'setTokens', set: { 'x;}': '1' } })).toThrow(/token/);
    expect(() => applyOp(doc, { type: 'setTokens', set: { 'a b': '1' } })).toThrow(/token/);
  });
});

describe('void tags and parents without children (B.1)', () => {
  it('createNode into img and moveNodes into input fail', () => {
    const { doc, frameId } = base();
    const d1 = applyOps(doc, [
      { type: 'createNode', parentId: frameId, node: mk('im_hard0001', 'img') },
      { type: 'createNode', parentId: frameId, node: mk('el_hard0008', 'input') },
      { type: 'createNode', parentId: frameId, node: mk('el_hard0009', 'div') },
    ]).doc;
    expect(() =>
      applyOp(d1, { type: 'createNode', parentId: 'im_hard0001', node: mk('el_hard0010', 'span') }),
    ).toThrow(/cannot have children/);
    expect(() =>
      applyOp(d1, { type: 'moveNodes', nodeIds: ['el_hard0009'], parentId: 'el_hard0008' }),
    ).toThrow(/cannot have children/);
  });

  it('NodeSchema rejects void with children or text; nodesToHtml throws', () => {
    const { doc } = base();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.pages[0].frames[0].tag = 'br';
    raw.pages[0].frames[0].text = 'x';
    expect(() => parseDocument(raw)).toThrow(/void/);
    const br = mk('el_hard0011', 'br', { children: [mk('el_hard0012', 'span')] });
    expect(() => nodesToHtml(br)).toThrow(/void/);
  });
});
