import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from './document.js';
import { exportHtml } from './export/html.js';
import { exportReact } from './export/react.js';
import { exportTailwind } from './export/tailwind.js';
import { parseDocument, serializeDocument } from './schema.js';
import type { Document } from './types.js';

function base(): Record<string, unknown> {
  return JSON.parse(serializeDocument(createDocument('Test', { id: 'doc_test0001' })));
}

describe('schema: tokenMeta and themes', () => {
  it('old document without the fields parses and serializes identically', () => {
    const doc = createDocument('Old', { id: 'doc_old00001' });
    doc.tokens = { '--a': '1px' };
    const text = serializeDocument(doc);
    expect(text).not.toContain('tokenMeta');
    expect(text).not.toContain('themes');
    const parsed = parseDocument(text);
    expect(parsed.tokenMeta).toBeUndefined();
    expect(parsed.themes).toBeUndefined();
    expect(serializeDocument(parsed)).toBe(text);
  });

  it('empty fields are not written', () => {
    const doc = createDocument('Empty', { id: 'doc_empty001' });
    doc.tokenMeta = {};
    doc.themes = [];
    const text = serializeDocument(doc);
    expect(text).not.toContain('tokenMeta');
    expect(text).not.toContain('themes');
  });

  it('round-trip with valid themes and metadata', () => {
    const doc = createDocument('New', { id: 'doc_new00001' });
    doc.tokens = { '--a': '1px' };
    doc.tokenMeta = { '--a': { group: 'spacing', description: 'x' } };
    doc.themes = [{ name: 'dark', overrides: { '--a': '2px' } }];
    const text = serializeDocument(doc);
    const parsed = parseDocument(text);
    expect(parsed.themes).toEqual(doc.themes);
    expect(parsed.tokenMeta).toEqual(doc.tokenMeta);
    expect(serializeDocument(parsed)).toBe(text);
  });

  it('invalid and duplicate themes are dropped without rejecting the document', () => {
    const raw = base();
    raw.themes = [
      { name: 'dark', overrides: { '--a': '2px' } },
      { name: 'dark', overrides: { '--a': '3px' } },
      { name: 'invalid name', overrides: {} },
      { name: 'bad', overrides: { '--x': 'red; color: blue' } },
      'junk',
      { name: 'light', overrides: { b: '1px' } },
    ];
    const doc = parseDocument(raw);
    expect(doc.themes).toEqual([
      { name: 'dark', overrides: { '--a': '2px' } },
      // a dangerous override is dropped (as with base tokens); the theme stays
      { name: 'bad', overrides: {} },
      { name: 'light', overrides: { '--b': '1px' } },
    ]);
  });

  it('all-invalid themes leave the field absent', () => {
    const raw = base();
    raw.themes = [{ name: '!!', overrides: {} }];
    expect(parseDocument(raw).themes).toBeUndefined();
  });

  it('tokenMeta with an invalid entry drops only that entry', () => {
    const raw = base();
    raw.tokenMeta = {
      '--ok': { group: 'color' },
      '--bad': { group: 123 },
      'no-prefix': { group: 'color' },
      '--empty': {},
      '--desc': { description: 'text' },
    };
    const doc = parseDocument(raw);
    expect(doc.tokenMeta).toEqual({
      '--ok': { group: 'color' },
      '--desc': { description: 'text' },
    });
  });

  it('fully invalid tokenMeta leaves the field absent', () => {
    const raw = base();
    raw.tokenMeta = { '--bad': 'text' };
    expect(parseDocument(raw).tokenMeta).toBeUndefined();
  });
});

describe('exporters with themes', () => {
  function themed(): Document {
    const doc = createDocument('Theme', { id: 'doc_theme001' });
    doc.tokens = { '--color-bg': '#ffffff', '--color-surface': 'var(--color-bg)' };
    doc.themes = [{ name: 'dark', overrides: { '--color-bg': '#111111' } }];
    doc.pages[0].frames.push(
      createNode({
        tag: 'div',
        type: 'frame',
        id: 'fr_theme001',
        name: 'Screen',
        attrs: { 'data-theme': 'dark' },
        style: { width: '400px', background: 'var(--color-surface)' },
        children: [createNode({ tag: 'p', id: 'tx_theme001', name: 'Text', text: 'Hi' })],
      }),
    );
    return doc;
  }

  it('html: theme rule and data-theme on the frame', () => {
    const html = exportHtml(themed());
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain('--color-bg: #111111;');
    // the dependent alias is redeclared inside the theme
    expect(html).toMatch(/\[data-theme="dark"\] \{[^}]*--color-surface: var\(--color-bg\);/);
    expect(html).toContain('data-theme="dark"');
  });

  it('html: without themes no theme rule is generated', () => {
    const doc = themed();
    delete doc.themes;
    expect(exportHtml(doc)).not.toContain('[data-theme=');
  });

  it('tailwind: theme rule and @custom-variant', () => {
    const out = exportTailwind(themed());
    expect(out).toContain('[data-theme="dark"] {');
    expect(out).toContain('@custom-variant theme-dark');
    expect(out).toContain('@custom-variant dark');
  });

  it('react inline: redeclares the theme variables on the node with data-theme', () => {
    const { code } = exportReact(themed(), { nodeId: 'fr_theme001', styles: 'inline' });
    expect(code).toContain("'--color-bg': '#111111'");
    expect(code).toContain("'--color-surface': 'var(--color-bg)'");
    expect(code).toContain('data-theme="dark"');
  });

  it('react tailwind: the css includes the theme rule', () => {
    const { css } = exportReact(themed(), { nodeId: 'fr_theme001' });
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('@custom-variant theme-dark');
  });
});
