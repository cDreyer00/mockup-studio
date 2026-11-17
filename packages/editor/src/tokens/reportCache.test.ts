import { describe, expect, it } from 'vitest';
import type { Document } from '@mockup/core';
import { nodeScopeVars, tokenListFor, tokenReportFor } from './reportCache';

const doc = (): Document =>
  ({
    version: 1,
    name: 'Teste',
    tokens: { '--a': '#fff', '--b': 'var(--a)' },
    pages: [
      {
        id: 'p1',
        name: 'Página',
        frames: [
          {
            id: 'f1',
            name: 'F',
            tag: 'div',
            style: { color: 'var(--a)' },
            attrs: {},
            children: [],
          },
        ],
      },
    ],
  }) as unknown as Document;

describe('tokenReportFor', () => {
  it('reaproveita o relatório quando só algo irrelevante muda', () => {
    const d = doc();
    const r = tokenReportFor(d);
    expect(tokenReportFor({ ...d, name: 'Outro' })).toBe(r);
  });

  it('recalcula quando tokens ou páginas mudam', () => {
    const d = doc();
    const r = tokenReportFor(d);
    const t = tokenReportFor({ ...d, tokens: { ...d.tokens, '--c': '1px' } });
    expect(t).not.toBe(r);
    expect(t.tokens.map((x) => x.name)).toContain('--c');
    expect(tokenReportFor({ ...d, pages: [...d.pages] })).not.toBe(t);
  });
});

describe('tokenListFor', () => {
  it('ignora mudanças em pages, mas recalcula com tokens', () => {
    const d = doc();
    const l = tokenListFor(d);
    expect(tokenListFor({ ...d, pages: [...d.pages] })).toBe(l);
    expect(tokenListFor({ ...d, tokens: { ...d.tokens } })).not.toBe(l);
  });
});

describe('nodeScopeVars', () => {
  it('guarda por documento e nó', () => {
    const d = doc();
    const v = nodeScopeVars(d, 'f1');
    expect(v['--a']).toBe('#fff');
    expect(nodeScopeVars(d, 'f1')).toBe(v);
    expect(nodeScopeVars({ ...d }, 'f1')).not.toBe(v);
  });
});
