import { describe, expect, it } from 'vitest';
import type { Document } from '@mockup/core';
import { nodeScopeVars, tokenListFor, tokenReportFor } from './reportCache';

const doc = (): Document =>
  ({
    version: 1,
    name: 'Test',
    tokens: { '--a': '#fff', '--b': 'var(--a)' },
    pages: [
      {
        id: 'p1',
        name: 'Page',
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
  it('reuses the report when only something irrelevant changes', () => {
    const d = doc();
    const r = tokenReportFor(d);
    expect(tokenReportFor({ ...d, name: 'Other' })).toBe(r);
  });

  it('recomputes when tokens or pages change', () => {
    const d = doc();
    const r = tokenReportFor(d);
    const t = tokenReportFor({ ...d, tokens: { ...d.tokens, '--c': '1px' } });
    expect(t).not.toBe(r);
    expect(t.tokens.map((x) => x.name)).toContain('--c');
    expect(tokenReportFor({ ...d, pages: [...d.pages] })).not.toBe(t);
  });
});

describe('tokenListFor', () => {
  it('ignores changes in pages, but recomputes with tokens', () => {
    const d = doc();
    const l = tokenListFor(d);
    expect(tokenListFor({ ...d, pages: [...d.pages] })).toBe(l);
    expect(tokenListFor({ ...d, tokens: { ...d.tokens } })).not.toBe(l);
  });
});

describe('nodeScopeVars', () => {
  it('caches per document and node', () => {
    const d = doc();
    const v = nodeScopeVars(d, 'f1');
    expect(v['--a']).toBe('#fff');
    expect(nodeScopeVars(d, 'f1')).toBe(v);
    expect(nodeScopeVars({ ...d }, 'f1')).not.toBe(v);
  });
});
