import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOp } from '../apply.js';
import { createDocument, createNode } from '../document.js';
import { parseDocument, serializeDocument } from '../schema.js';
import { cssValueProblem, normalizeStyles } from '../styles.js';
import type { Document } from '../types.js';
import { exportHtml } from './html.js';
import { exportReact } from './react.js';
import { exportSvg } from './svg.js';
import { exportTailwind } from './tailwind.js';

const landingRaw = JSON.parse(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

/** Documento mínimo em JSON cru (como um arquivo antigo/editado à mão). */
function rawDoc(style: Record<string, string>, tokens: Record<string, string> = {}): unknown {
  return {
    version: 1,
    id: 'doc_seg',
    name: 'Segurança',
    tokens,
    pages: [
      {
        id: 'pg_seg',
        name: 'P',
        frames: [
          {
            id: 'fr_seg00001',
            type: 'frame',
            name: 'Tela',
            tag: 'div',
            attrs: {},
            style: { width: '100px', ...style },
            children: [],
          },
        ],
      },
    ],
  };
}

const BAD_VALUES = [
  'red; } body { display: none',
  'red}',
  '{red',
  'url(x) ; color: blue',
  'red </style><script>alert(1)</script>',
  '"abc',
  'red)',
  'rgb(1,2,3',
  'red /* x */',
];

describe('cssValueProblem', () => {
  it.each([
    'red',
    '1px solid var(--color-muted)',
    'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'/>")',
    'url(data:image/png;base64,AAAA)',
    '"texto; com { chaves } dentro"',
    "'a;b'",
    'calc(100% - (2 * 8px))',
    'Inter, "Open Sans", sans-serif',
    '"\\"; ainda dentro"',
  ])('aceita %s', (v) => {
    expect(cssValueProblem(v)).toBeNull();
  });

  it.each(BAD_VALUES)('recusa %s', (v) => {
    expect(cssValueProblem(v)).toEqual(expect.any(String));
  });

  it('recusa </style em qualquer caixa, mesmo entre aspas', () => {
    expect(cssValueProblem('"</STYLE>"')).toMatch(/style/);
  });
});

describe('normalizeStyles / updateStyles', () => {
  it('normalizeStyles recusa valores que quebram a regra, com mensagem clara', () => {
    expect(() => normalizeStyles({ color: 'red; } a { x: y' })).toThrow(
      /Valor CSS inválido em "color"/,
    );
    expect(() => normalizeStyles({ 'a b': 'x' })).toThrow(/Nome de propriedade CSS inválido/);
  });

  it('updateStyles recusa valor e chave inválidos', () => {
    const doc = createDocument('T', { id: 'doc_t' });
    doc.pages[0].frames.push(
      createNode({ tag: 'div', type: 'frame', id: 'fr_aaaaaaaa', name: 'F' }),
    );
    for (const v of BAD_VALUES) {
      expect(() =>
        applyOp(doc, { type: 'updateStyles', nodeIds: ['fr_aaaaaaaa'], styles: { color: v } }),
      ).toThrow(/Valor CSS inválido/);
    }
    expect(() =>
      applyOp(doc, {
        type: 'updateStyles',
        nodeIds: ['fr_aaaaaaaa'],
        styles: { 'color: red; x': 'y' },
      }),
    ).toThrow(/inválido/);
    const ok = applyOp(doc, {
      type: 'updateStyles',
      nodeIds: ['fr_aaaaaaaa'],
      styles: { color: 'red' },
    }).doc;
    expect(ok.pages[0].frames[0].style.color).toBe('red');
  });
});

describe('leitura de arquivos', () => {
  it('parseDocument só descarta a declaração ruim, sem recusar o arquivo', () => {
    const doc = parseDocument(
      rawDoc({
        color: 'red; } body { display: none',
        'background-color': 'blue',
        'bad key': 'x',
        content: '"</style>"',
      }),
    );
    expect(doc.pages[0].frames[0].style).toEqual({ width: '100px', 'background-color': 'blue' });
  });

  it('parseDocument descarta tokens com valor perigoso e mantém os demais', () => {
    const doc = parseDocument(rawDoc({}, { '--a': 'red; } x {', '--b': '#fff' }));
    expect(doc.tokens).toEqual({ '--b': '#fff' });
  });
});

describe('exportadores saneiam arquivos antigos', () => {
  /** Documento com estilo ruim que escapou da leitura (montado direto, sem passar pelo parser). */
  function dirtyDoc(): Document {
    const doc = createDocument('Sujo', { id: 'doc_sujo' });
    const frame = createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_sujo0001',
      name: 'Tela',
      style: { width: '100px', height: '50px' },
    });
    frame.style.color = 'red; } body { display: none';
    frame.style['bad key'] = 'x';
    frame.style['background-color'] = 'blue';
    frame.style.content = '"</style><script>alert(1)</script>"';
    doc.pages[0].frames.push(frame);
    doc.tokens = { '--ok': '#fff', '--ruim': 'red; } body { display: none', semprefixo: '1' };
    return doc;
  }

  const checks = (out: string): void => {
    expect(out).not.toContain('display: none');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('bad key');
    expect(out).not.toContain('--ruim');
    expect(out).not.toContain('semprefixo');
    expect(out).not.toMatch(/<\/style><script/);
  };

  it('html (classes e inline)', () => {
    for (const mode of ['classes', 'inline'] as const) {
      const out = exportHtml(dirtyDoc(), { mode });
      checks(out);
      expect(out).toContain('blue');
      expect(out).toContain('--ok: #fff');
    }
  });

  it('tailwind', () => {
    const out = exportTailwind(dirtyDoc());
    checks(out);
    expect(out).toContain('--ok: #fff');
  });

  it('react (tailwind e inline)', () => {
    for (const styles of ['tailwind', 'inline'] as const) {
      const r = exportReact(dirtyDoc(), { nodeId: 'fr_sujo0001', styles });
      checks(r.code + (r.css ?? ''));
    }
  });

  it('svg (fallback)', () => {
    checks(exportSvg(dirtyDoc(), { nodeId: 'fr_sujo0001' }));
  });
});

describe('prefixo -- dos tokens', () => {
  it('parseDocument acrescenta o prefixo e mantém os que já têm', () => {
    const raw = structuredClone(landingRaw) as { tokens: Record<string, string> };
    raw.tokens = { primary: '#6c5ce7', '--color-bg': '#000', ' espaco ': '1' };
    const doc = parseDocument(raw);
    expect(doc.tokens).toEqual({ '--primary': '#6c5ce7', '--color-bg': '#000', '--espaco': '1' });
    // ida e volta estável
    expect(parseDocument(serializeDocument(doc)).tokens).toEqual(doc.tokens);
  });

  it('setTokens acrescenta o prefixo em set e em unset', () => {
    const doc = parseDocument(landingRaw);
    const a = applyOp(doc, { type: 'setTokens', set: { accent: '#f0f', '--ok': '1' } });
    expect(a.doc.tokens.accent).toBeUndefined();
    expect(a.doc.tokens['--accent']).toBe('#f0f');
    expect(a.doc.tokens['--ok']).toBe('1');
    const b = applyOp(a.doc, { type: 'setTokens', unset: ['accent'] });
    expect(b.doc.tokens['--accent']).toBeUndefined();
    // o inverso restaura o estado anterior
    const back = applyOp(b.doc, b.inverse[0]);
    expect(back.doc.tokens['--accent']).toBe('#f0f');
  });

  it('setTokens recusa nome inválido e valor perigoso', () => {
    const doc = parseDocument(landingRaw);
    expect(() => applyOp(doc, { type: 'setTokens', set: { 'a b': '1' } })).toThrow(/token/);
    expect(() => applyOp(doc, { type: 'setTokens', set: { '--x': 'red; } a {' } })).toThrow(
      /valor inválido/,
    );
  });
});
