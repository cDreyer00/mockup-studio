import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from './apply.js';
import { createDocument, createNode, createNodeFromTag, findNode } from './document.js';
import { exportHtml } from './export/html.js';
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
    expect(() => normalizeTag('SCRIPT')).toThrow(/Tag inválida/);
    expect(() => normalizeTag('a b')).toThrow(/Tag inválida/);
  });

  it('createNode lança para tag bloqueada em qualquer caixa', () => {
    expect(() => createNode({ tag: 'SCRIPT' })).toThrow(/Tag inválida/);
    expect(createNode({ tag: 'DIV' }).tag).toBe('div');
  });

  it('parseDocument rejeita tag Script', () => {
    const { doc } = base();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.pages[0].frames[0].tag = 'Script';
    expect(() => parseDocument(raw)).toThrow(/tag bloqueada/);
    raw.pages[0].frames[0].tag = 'a_b';
    expect(() => parseDocument(raw)).toThrow(/tag inválida/);
  });

  it('htmlToNodes pula iframe/object/embed/base e tags fora do regex', () => {
    const ns = htmlToNodes('<iframe src=x></iframe><p>a</p><my_tag>x</my_tag><base href="/">');
    expect(ns.map((n) => n.tag)).toEqual(['p']);
  });
});

describe('URLs perigosas em atributos (htmlToNodes)', () => {
  it('descarta href/src/action/formaction com javascript: ou data: não-imagem e srcdoc', () => {
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
  it('remove script, on* e foreignObject', () => {
    const [svg] = htmlToNodes(
      '<svg onload="alert(1)"><script>alert(2)</script><circle onclick="x()"/></svg>',
    );
    expect(svg!.svg).not.toMatch(/\son\w+=|<script/i);
    expect(svg!.svg).toContain('<circle');
    expect(sanitizeSvg('<svg><foreignObject><div/></foreignObject><g/></svg>')).toBe(
      '<svg><g/></svg>',
    );
    expect(sanitizeSvg('<p>nada</p>')).toBe('');
  });

  it('href perigoso é removido; data:image é mantido; viewBox preservado', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 1 1"><a xlink:href=" JaVa\tscript:alert(1)"/><a href="data:text/html,x"/>' +
        '<image href="data:image/png;base64,AAAA"/></svg>',
    );
    expect(out).toContain('viewBox="0 0 1 1"');
    expect(out).not.toMatch(/javascript|text\/html/i);
    expect(out).toContain('href="data:image/png;base64,AAAA"');
  });

  it('remove elementos fora da lista de permissão (escape do contexto SVG no HTML exportado)', () => {
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

  it('remove comentários, CDATA e diretivas (comentário fechado em --!> pelo parser HTML)', () => {
    const out = sanitizeSvg('<svg><!-- --!><img src=x onerror=alert(1)> --><rect/></svg>');
    expect(out).not.toMatch(/onerror|<!--|<img/i);
    expect(out).toBe('<svg><rect/></svg>');
    const cdata = sanitizeSvg(
      '<svg><![CDATA[<img onerror=1>]]><?x <img onerror=2>?><text>ok</text></svg>',
    );
    expect(cdata).not.toMatch(/onerror|CDATA|<\?x/i);
    expect(cdata).toContain('<text>ok</text>');
  });

  it('use só aceita href para fragmento', () => {
    const out = sanitizeSvg(
      '<svg><use href="#ok"/><use href="data:image/svg+xml,x"/><use xlink:href="https://a.dev/x.svg#y"/></svg>',
    );
    expect(out).toContain('<use href="#ok"/>');
    expect(out).not.toMatch(/data:|https:/);
  });

  it('href com prefixo de namespace arbitrário é tratado como href', () => {
    const out = sanitizeSvg(
      '<svg xmlns:x="http://www.w3.org/1999/xlink"><a x:href="javascript:alert(1)">a</a>' +
        '<use x:href="#ok"/></svg>',
    );
    expect(out).not.toMatch(/javascript/i);
    expect(out).toContain('x:href="#ok"');
    expect(out).toContain('xmlns:x=');
  });

  it('NodeSchema sanitiza o campo svg', () => {
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
  it('createNode com node incompleto lança mencionando o campo faltante', () => {
    const { doc, frameId } = base();
    expect(() =>
      applyOp(doc, { type: 'createNode', parentId: frameId, node: { id: 'x' } } as never),
    ).toThrow(/Operação inválida: node\.type/);
  });

  it('tipo desconhecido', () => {
    const { doc } = base();
    expect(() => applyOp(doc, { type: 'xyz' } as never)).toThrow(/Operação inválida/);
    expect(() => parseOp(null)).toThrow(/Operação inválida/);
  });

  it('defaults/sanitização valem no createNode; documento segue válido (inclusive undo/redo)', () => {
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
      { type: 'setText', changes: [{ nodeId: 'el_hard0002', text: 'oi' }] },
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

describe('inversos exatos (item 4)', () => {
  it('setText em nó sem texto: undo remove o campo', () => {
    const { doc, frameId } = base();
    const r = applyOp(doc, { type: 'setText', changes: [{ nodeId: frameId, text: 'x' }] });
    expect(findNode(r.doc, frameId)!.node.text).toBe('x');
    const back = applyOps(r.doc, r.inverse).doc;
    expect('text' in findNode(back, frameId)!.node).toBe(false);
  });

  it('setPosition em nó sem position: undo remove o campo; null remove', () => {
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

describe('duplicateNodes com ancestral + descendente (item 5)', () => {
  it('duplica só o topo', () => {
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

describe('espaços em texto misto (item 6)', () => {
  it('regras', () => {
    const [p] = htmlToNodes('<p>Olá <b>mundo</b> fim</p>');
    expect(p!.children.map((c) => c.text)).toEqual(['Olá ', 'mundo', ' fim']);
    expect(htmlToNodes('<p>\n  Texto\n</p>')[0]!.text).toBe('Texto');
    expect(htmlToNodes('<span>Olá </span>')[0]!.text).toBe('Olá ');
  });

  it('round-trip estável em duas passagens', () => {
    const h1 = nodesToHtml(htmlToNodes('<p>Olá <b>mundo</b> fim</p>')).html;
    expect(h1).toContain('Olá </span>');
    expect(h1).toContain('<span> fim');
    expect(nodesToHtml(htmlToNodes(h1)).html).toBe(h1);
  });
});

describe('escaping (item 7)', () => {
  it('nome de atributo malicioso lança na saída', () => {
    const n = mk('el_hard0005', 'div', { attrs: { 'x" onmouseover="alert(1)': '1' } });
    expect(() => nodesToHtml(n)).toThrow(/atributo inválido/);
  });

  it('aspas simples escapadas em valores de atributo', () => {
    const n = mk('el_hard0006', 'div', { attrs: { title: "a'b" } });
    expect(nodesToHtml(n).html).toContain('title="a&#39;b"');
  });

  it('setAttrs rejeita on* e nomes inválidos', () => {
    const { doc, frameId } = base();
    const set = (k: string): Op => ({
      type: 'setAttrs',
      changes: [{ nodeId: frameId, set: { [k]: '1' } }],
    });
    expect(() => applyOp(doc, set('onclick'))).toThrow(/on\*/);
    expect(() => applyOp(doc, set('OnLoad'))).toThrow(/on\*/);
    expect(() => applyOp(doc, set('a b'))).toThrow(/inválido/);
  });

  it('htmlToNodes descarta on* e atributos inválidos', () => {
    const [p] = htmlToNodes('<p onclick="x()" title="t" data-ok="1">a</p>');
    expect(p!.attrs).toEqual({ title: 't', 'data-ok': '1' });
  });

  it('NodeSchema valida chaves de attrs', () => {
    const { doc } = base();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.pages[0].frames[0].attrs = { 'a b': '1' };
    expect(() => parseDocument(raw)).toThrow(/atributo/);
  });

  it('</style> não escapa de <style> (classes e tokens)', () => {
    const n = mk('el_hard0007', 'div', { style: { content: '"</style><script>"' } });
    const { css } = nodesToHtml(n, { mode: 'classes' });
    expect(css).not.toContain('</style>');
    expect(css).toContain('<\\/style>');
    const { doc, frameId } = base();
    const d1 = applyOp(doc, { type: 'createNode', parentId: frameId, node: n }).doc;
    const d2 = applyOp(d1, {
      type: 'setTokens',
      set: { '--x': '</style><script>alert(1)</script>' },
    }).doc;
    const out = exportHtml(d2);
    expect(out).not.toContain('</style><script>');
    expect(out.match(/<\/style>/g)).toHaveLength(1);
  });

  it('nomes de token inválidos são rejeitados', () => {
    const { doc } = base();
    expect(() => applyOp(doc, { type: 'setTokens', set: { 'x;}': '1' } })).toThrow(/token/);
    expect(() => applyOp(doc, { type: 'setTokens', set: { x: '1' } })).toThrow(/token/);
  });
});

describe('tags void e pais sem filhos (B.1)', () => {
  it('createNode em img e moveNodes para input falham', () => {
    const { doc, frameId } = base();
    const d1 = applyOps(doc, [
      { type: 'createNode', parentId: frameId, node: mk('im_hard0001', 'img') },
      { type: 'createNode', parentId: frameId, node: mk('el_hard0008', 'input') },
      { type: 'createNode', parentId: frameId, node: mk('el_hard0009', 'div') },
    ]).doc;
    expect(() =>
      applyOp(d1, { type: 'createNode', parentId: 'im_hard0001', node: mk('el_hard0010', 'span') }),
    ).toThrow(/não pode ter filhos/);
    expect(() =>
      applyOp(d1, { type: 'moveNodes', nodeIds: ['el_hard0009'], parentId: 'el_hard0008' }),
    ).toThrow(/não pode ter filhos/);
  });

  it('NodeSchema rejeita void com filhos ou texto; nodesToHtml lança', () => {
    const { doc } = base();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.pages[0].frames[0].tag = 'br';
    raw.pages[0].frames[0].text = 'x';
    expect(() => parseDocument(raw)).toThrow(/void/);
    const br = mk('el_hard0011', 'br', { children: [mk('el_hard0012', 'span')] });
    expect(() => nodesToHtml(br)).toThrow(/void/);
  });
});
