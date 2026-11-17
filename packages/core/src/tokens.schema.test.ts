import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from './document.js';
import { exportHtml } from './export/html.js';
import { exportReact } from './export/react.js';
import { exportTailwind } from './export/tailwind.js';
import { parseDocument, serializeDocument } from './schema.js';
import type { Document } from './types.js';

function base(): Record<string, unknown> {
  return JSON.parse(serializeDocument(createDocument('Teste', { id: 'doc_test0001' })));
}

describe('schema: tokenMeta e themes', () => {
  it('documento antigo sem os campos faz parse e serialize idênticos', () => {
    const doc = createDocument('Antigo', { id: 'doc_old00001' });
    doc.tokens = { '--a': '1px' };
    const texto = serializeDocument(doc);
    expect(texto).not.toContain('tokenMeta');
    expect(texto).not.toContain('themes');
    const lido = parseDocument(texto);
    expect(lido.tokenMeta).toBeUndefined();
    expect(lido.themes).toBeUndefined();
    expect(serializeDocument(lido)).toBe(texto);
  });

  it('campos vazios não são escritos', () => {
    const doc = createDocument('Vazio', { id: 'doc_vazio001' });
    doc.tokenMeta = {};
    doc.themes = [];
    const texto = serializeDocument(doc);
    expect(texto).not.toContain('tokenMeta');
    expect(texto).not.toContain('themes');
  });

  it('round-trip com temas e metadados válidos', () => {
    const doc = createDocument('Novo', { id: 'doc_novo0001' });
    doc.tokens = { '--a': '1px' };
    doc.tokenMeta = { '--a': { group: 'spacing', description: 'x' } };
    doc.themes = [{ name: 'dark', overrides: { '--a': '2px' } }];
    const texto = serializeDocument(doc);
    const lido = parseDocument(texto);
    expect(lido.themes).toEqual(doc.themes);
    expect(lido.tokenMeta).toEqual(doc.tokenMeta);
    expect(serializeDocument(lido)).toBe(texto);
  });

  it('temas inválidos e duplicados são descartados sem recusar o documento', () => {
    const raw = base();
    raw.themes = [
      { name: 'dark', overrides: { '--a': '2px' } },
      { name: 'dark', overrides: { '--a': '3px' } },
      { name: 'nome inválido', overrides: {} },
      { name: 'ruim', overrides: { '--x': 'red; color: blue' } },
      'lixo',
      { name: 'light', overrides: { b: '1px' } },
    ];
    const doc = parseDocument(raw);
    expect(doc.themes).toEqual([
      { name: 'dark', overrides: { '--a': '2px' } },
      // override perigosa é descartada (como nos tokens base); o tema continua
      { name: 'ruim', overrides: {} },
      { name: 'light', overrides: { '--b': '1px' } },
    ]);
  });

  it('todos os temas inválidos deixam o campo ausente', () => {
    const raw = base();
    raw.themes = [{ name: '!!', overrides: {} }];
    expect(parseDocument(raw).themes).toBeUndefined();
  });

  it('tokenMeta com entrada inválida descarta só a entrada', () => {
    const raw = base();
    raw.tokenMeta = {
      '--ok': { group: 'color' },
      '--ruim': { group: 123 },
      'sem-prefixo': { group: 'color' },
      '--vazio': {},
      '--desc': { description: 'texto' },
    };
    const doc = parseDocument(raw);
    expect(doc.tokenMeta).toEqual({
      '--ok': { group: 'color' },
      '--desc': { description: 'texto' },
    });
  });

  it('tokenMeta todo inválido deixa o campo ausente', () => {
    const raw = base();
    raw.tokenMeta = { '--ruim': 'texto' };
    expect(parseDocument(raw).tokenMeta).toBeUndefined();
  });
});

describe('exportadores com temas', () => {
  function themed(): Document {
    const doc = createDocument('Tema', { id: 'doc_theme001' });
    doc.tokens = { '--color-bg': '#ffffff', '--color-surface': 'var(--color-bg)' };
    doc.themes = [{ name: 'dark', overrides: { '--color-bg': '#111111' } }];
    doc.pages[0].frames.push(
      createNode({
        tag: 'div',
        type: 'frame',
        id: 'fr_theme001',
        name: 'Tela',
        attrs: { 'data-theme': 'dark' },
        style: { width: '400px', background: 'var(--color-surface)' },
        children: [createNode({ tag: 'p', id: 'tx_theme001', name: 'Texto', text: 'Oi' })],
      }),
    );
    return doc;
  }

  it('html: regra do tema e data-theme no frame', () => {
    const html = exportHtml(themed());
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain('--color-bg: #111111;');
    // o alias dependente é redeclarado dentro do tema
    expect(html).toMatch(/\[data-theme="dark"\] \{[^}]*--color-surface: var\(--color-bg\);/);
    expect(html).toContain('data-theme="dark"');
  });

  it('html: sem temas não gera regra de tema', () => {
    const doc = themed();
    delete doc.themes;
    expect(exportHtml(doc)).not.toContain('[data-theme=');
  });

  it('tailwind: regra do tema e @custom-variant', () => {
    const out = exportTailwind(themed());
    expect(out).toContain('[data-theme="dark"] {');
    expect(out).toContain('@custom-variant theme-dark');
    expect(out).toContain('@custom-variant dark');
  });

  it('react inline: redeclara as variáveis do tema no nó com data-theme', () => {
    const { code } = exportReact(themed(), { nodeId: 'fr_theme001', styles: 'inline' });
    expect(code).toContain("'--color-bg': '#111111'");
    expect(code).toContain("'--color-surface': 'var(--color-bg)'");
    expect(code).toContain('data-theme="dark"');
  });

  it('react tailwind: o css traz a regra do tema', () => {
    const { css } = exportReact(themed(), { nodeId: 'fr_theme001' });
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('@custom-variant theme-dark');
  });
});
