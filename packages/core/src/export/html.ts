import { deepClone } from '../clone.js';
import { findNode, findPage } from '../document.js';
import { escapeCssText, nodesToHtml } from '../html.js';
import type { Document, Node } from '../types.js';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Converte `position` do canvas em left/top para filhos com `position: absolute`. */
function applyCanvasPositions(node: Node, isRoot: boolean): void {
  if (!isRoot && node.style.position === 'absolute' && node.position) {
    if (!node.style.left) node.style.left = `${node.position.x}px`;
    if (!node.style.top) node.style.top = `${node.position.y}px`;
  }
  for (const c of node.children) applyCanvasPositions(c, false);
}

/** Exporta HTML standalone (frames da página ou nós selecionados). */
export function exportHtml(
  doc: Document,
  options: {
    pageId?: string;
    nodeIds?: string[];
    title?: string;
    mode?: 'inline' | 'classes';
  } = {},
): string {
  const mode = options.mode ?? 'classes';
  let nodes: Node[];
  if (options.nodeIds && options.nodeIds.length > 0) {
    nodes = options.nodeIds.map((id) => {
      const path = findNode(doc, id);
      if (!path) throw new Error(`Nó "${id}" não encontrado`);
      return path.node;
    });
  } else {
    const page = options.pageId ? findPage(doc, options.pageId) : doc.pages[0];
    if (!page) throw new Error(`Página "${options.pageId ?? ''}" não encontrada`);
    nodes = page.frames;
  }
  const copies = deepClone(nodes);
  copies.forEach((n) => applyCanvasPositions(n, true));

  const { html, css } = nodesToHtml(copies, { mode, indent: true });

  const tokenLines = Object.entries(doc.tokens).map(([k, v]) => `    ${k}: ${escapeCssText(v)};`);
  const style: string[] = [];
  if (tokenLines.length > 0) style.push(`  :root {\n${tokenLines.join('\n')}\n  }`);
  style.push('  *{box-sizing:border-box;margin:0}');
  if (css)
    style.push(
      escapeCssText(css)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );

  const body = html
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(options.title ?? doc.name)}</title>`,
    '  <style>',
    style.join('\n'),
    '  </style>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
