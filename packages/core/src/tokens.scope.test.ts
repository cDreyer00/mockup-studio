import { describe, expect, it } from 'vitest';
import { getComputedLike } from './computed.js';
import { createDocument, createNode } from './document.js';
import {
  getTokenReport,
  inlineSvgVars,
  resolvedTokens,
  resolvedTokensDetailed,
  resolveScope,
  resolveScopeDetailed,
  scopeVarsFor,
} from './tokens.js';
import type { Document, Node } from './types.js';

function el(
  id: string,
  style: Record<string, string> = {},
  children: Node[] = [],
  attrs: Record<string, string> = {},
): Node {
  return createNode({ tag: 'div', id, name: id, style, children, attrs });
}

function docWith(
  frame: Node,
  extra: Partial<Pick<Document, 'tokens' | 'tokenMeta' | 'themes'>> = {},
): Document {
  const doc = createDocument('Teste', { id: 'doc_scope001' });
  doc.pages[0].frames.push({ ...frame, type: 'frame' });
  Object.assign(doc, extra);
  return doc;
}

const THEMED = {
  tokens: { '--fg': '#000', '--bg': '#fff' },
  themes: [{ name: 'dark', overrides: { '--fg': '#fff', '--bg': '#000' } }],
};

describe('escopo de variáveis como no CSS', () => {
  it('herdada não muda com tema no descendente', () => {
    // O frame (claro) declara color: var(--fg); o filho tem data-theme="dark" mas não declara color.
    const doc = docWith(
      el('fr_main0001', { color: 'var(--fg)' }, [
        el('el_filho001', { background: 'var(--bg)' }, [], { 'data-theme': 'dark' }),
      ]),
      THEMED,
    );
    const c = getComputedLike(doc, 'el_filho001');
    expect(c.color).toBe('#000');
    // O que o próprio filho declara é resolvido no escopo dele (tema escuro).
    expect(c.background).toBe('#000');
  });

  it('herdada é resolvida no ancestral que a declara, não no mais próximo', () => {
    const doc = docWith(
      el('fr_main0001', { color: 'var(--fg)' }, [
        el('el_meio0001', { '--fg': 'red' }, [el('el_neto0001')]),
      ]),
      THEMED,
    );
    expect(getComputedLike(doc, 'el_neto0001').color).toBe('#000');
  });

  it('variável que aponta para token inexistente fica inválida e o fallback vale', () => {
    const r = resolveScope({}, { '--a': 'var(--missing)', '--b': 'var(--a, blue)' });
    expect(r['--b']).toBe('blue');
    expect('--a' in r).toBe(false);
    const d = resolveScopeDetailed({}, { '--a': 'var(--missing)', '--c': 'var(--a)' });
    expect(d.invalid).toEqual({ '--a': ['--missing'], '--c': ['--a'] });
  });

  it('variável inválida declarada no elemento não herda o valor do ancestral', () => {
    const r = resolveScope({ '--a': 'red' }, { '--a': 'var(--missing)' });
    expect('--a' in r).toBe(false);
  });

  it('resolvedTokensDetailed junta os inválidos da base e do tema', () => {
    const doc = docWith(el('fr_main0001'), {
      tokens: { '--a': 'var(--nada)', '--b': '1px' },
      themes: [{ name: 't', overrides: { '--a': '2px', '--b': 'var(--zero)' } }],
    });
    expect(resolvedTokensDetailed(doc).invalid).toEqual({ '--a': ['--nada'] });
    expect(resolvedTokensDetailed(doc, 't').invalid).toEqual({ '--b': ['--zero'] });
    expect(resolvedTokens(doc, 't')['--a']).toBe('2px');
  });

  it('opção theme força o tema no próprio nó, mesmo com data-theme no frame', () => {
    const doc = docWith(
      el('fr_main0001', { background: 'var(--bg)' }, [], { 'data-theme': 'dark' }),
      {
        ...THEMED,
        themes: [...THEMED.themes, { name: 'sepia', overrides: { '--bg': '#f4ecd8' } }],
      },
    );
    expect(getComputedLike(doc, 'fr_main0001').background).toBe('#000');
    expect(getComputedLike(doc, 'fr_main0001', { theme: 'sepia' }).background).toBe('#f4ecd8');
    expect(scopeVarsFor(doc, 'fr_main0001', { theme: 'sepia' })['--bg']).toBe('#f4ecd8');
  });

  it('opção theme num filho vale para o filho (o frame continua no tema dele)', () => {
    const doc = docWith(
      el('fr_main0001', { color: 'var(--fg)' }, [el('el_filho001', { background: 'var(--bg)' })], {
        'data-theme': 'dark',
      }),
      { ...THEMED, themes: [...THEMED.themes, { name: 'light', overrides: { '--bg': '#eee' } }] },
    );
    const c = getComputedLike(doc, 'el_filho001', { theme: 'light' });
    expect(c.background).toBe('#eee');
    expect(c.color).toBe('#fff');
  });
});

describe('relatório com variáveis inválidas', () => {
  it('distingue token inexistente de token sem valor válido', () => {
    const doc = docWith(el('fr_main0001'), {
      tokens: { '--a': 'var(--missing)', '--b': 'var(--a)', '--c': 'var(--a, blue)' },
    });
    const r = getTokenReport(doc);
    const by = (n: string) => r.tokens.find((t) => t.name === n)!;
    expect(by('--a').problem?.message).toMatch(/inexistente: --missing/);
    expect(by('--b').problem?.message).toMatch(/sem valor válido: --a \(→ --missing\)/);
    expect(by('--c').problem).toBeUndefined();
    expect(by('--c').resolved).toBe('blue');
    expect(by('--a').resolved).toBeUndefined();
  });

  it('cache da parte de tokens não fica defasado com mutação no lugar', () => {
    const doc = docWith(el('fr_main0001', { color: 'var(--a)' }), { tokens: { '--a': 'red' } });
    const r1 = getTokenReport(doc);
    expect(r1.tokens[0]!.resolved).toBe('red');
    expect(r1.tokens[0]!.usage.nodeIds).toEqual(['fr_main0001']);
    doc.tokens['--a'] = 'blue';
    doc.pages[0].frames[0]!.style = {};
    const r2 = getTokenReport(doc);
    expect(r2.tokens[0]!.resolved).toBe('blue');
    expect(r2.tokens[0]!.usage.nodeIds).toEqual([]);
  });
});

describe('inlineSvgVars', () => {
  const vars = { '--brand': '#2563eb', '--font': '"Inter", sans-serif' };

  it('troca var() por valores do escopo, com fallback e escape XML', () => {
    const svg =
      '<svg><circle style="fill:var(--brand)"/><rect fill="var(--nada, red)"/>' +
      '<text style="font-family:var(--font)"/></svg>';
    expect(inlineSvgVars(svg, vars)).toBe(
      '<svg><circle style="fill:#2563eb"/><rect fill="red"/>' +
        '<text style="font-family:&quot;Inter&quot;, sans-serif"/></svg>',
    );
  });

  it('mantém var() sem valor nem fallback e as declaradas dentro do próprio SVG', () => {
    const svg =
      '<svg style="--brand: green"><path fill="var(--brand, blue)" stroke="var(--x)"/></svg>';
    expect(inlineSvgVars(svg, vars)).toBe(svg);
  });

  it('segue o tema efetivo do nó via scopeVarsFor', () => {
    const svgNode: Node = {
      ...el('el_svg00001'),
      type: 'svg',
      svg: '<svg><circle style="fill:var(--fg)"/></svg>',
    };
    const doc = docWith(el('fr_main0001', {}, [svgNode], { 'data-theme': 'dark' }), THEMED);
    expect(inlineSvgVars(svgNode.svg!, scopeVarsFor(doc, 'el_svg00001'))).toBe(
      '<svg><circle style="fill:#fff"/></svg>',
    );
    expect(inlineSvgVars(svgNode.svg!, scopeVarsFor(doc, 'el_svg00001', { theme: 'x' }))).toContain(
      'fill:#fff',
    );
    delete doc.pages[0].frames[0]!.attrs['data-theme'];
    expect(inlineSvgVars(svgNode.svg!, scopeVarsFor(doc, 'el_svg00001'))).toContain('fill:#000');
  });
});
