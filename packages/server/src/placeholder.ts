/**
 * Placeholders SVG num nó: troca o `src` de uma imagem ou cria uma imagem dentro de um contêiner.
 * Compartilhado pela ferramenta MCP `generate_placeholder` e pela rota HTTP do editor.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PLACEHOLDER_KINDS,
  PLACEHOLDER_SIZES,
  createNodeFromTag,
  findNode,
  placeholderFileName,
  placeholderSvg,
  svgDataUrl,
  type Document,
  type Op,
  type PlaceholderKind,
} from '@mockup/core';
import { writeAsset } from './assets.js';

export class PlaceholderError extends Error {}

export interface PlaceholderInput {
  nodeId: string;
  kind: PlaceholderKind;
  seed?: string | number;
  width?: number;
  height?: number;
  label?: string;
}

export interface PlaceholderResult {
  ops: Op[];
  /** Valor do `src` aplicado (caminho relativo a `assets/` ou data URL). */
  src: string;
  /** Id do nó com o placeholder (o `img` criado, quando o alvo era um contêiner). */
  nodeId: string;
  /** Descrição de onde o SVG ficou. */
  where: string;
}

/** Grava o SVG em `assets/placeholders/` (reutiliza igual, nunca sobrescreve diferente). */
async function storeSvg(assetsDir: string, fileName: string, svg: string): Promise<string> {
  const dir = path.join(assetsDir, 'placeholders');
  const bytes = Buffer.from(svg, 'utf8');
  try {
    const existing = await fs.promises.readFile(path.join(dir, fileName));
    if (existing.equals(bytes)) return `placeholders/${fileName}`;
  } catch {
    // não existe ainda
  }
  const finalName = await writeAsset(dir, fileName, bytes);
  return `placeholders/${finalName}`;
}

export async function buildPlaceholder(
  doc: Document,
  assetsDir: string | null,
  input: PlaceholderInput,
): Promise<PlaceholderResult> {
  if (!PLACEHOLDER_KINDS.includes(input.kind)) {
    throw new PlaceholderError(
      `kind inválido: "${String(input.kind)}". Use ${PLACEHOLDER_KINDS.join(', ')}.`,
    );
  }
  const p = findNode(doc, input.nodeId);
  if (!p) {
    throw new PlaceholderError(
      `Nó não encontrado: "${input.nodeId}". Use get_tree_summary para listar ids válidos.`,
    );
  }
  const t = p.node.type;
  if (t === 'text' || t === 'svg') {
    throw new PlaceholderError(
      `O nó ${input.nodeId} é ${t}; use um nó de imagem (troca o src) ou um contêiner (ganha uma imagem filha).`,
    );
  }
  const opts = {
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
    ...(input.label ? { label: input.label } : {}),
  };
  const svg = placeholderSvg(input.kind, opts);
  let src: string;
  let where: string;
  if (assetsDir) {
    src = await storeSvg(assetsDir, placeholderFileName(input.kind, opts), svg);
    where = `assets/${src}`;
  } else {
    src = svgDataUrl(svg);
    where = 'data URL embutida (documento sem caminho em disco)';
  }
  if (t === 'image') {
    return {
      ops: [{ type: 'setSrc', changes: [{ nodeId: input.nodeId, src }] }],
      src,
      nodeId: input.nodeId,
      where,
    };
  }
  const [dw, dh] = PLACEHOLDER_SIZES[input.kind];
  const w = input.width ?? (input.height ? Math.round((dw * input.height) / dh) : dw);
  const h = input.height ?? (input.width ? Math.round((dh * input.width) / dw) : dh);
  const img = createNodeFromTag('img', {
    name: `Placeholder ${input.kind}`,
    src,
    attrs: { alt: `Placeholder ${input.kind}` },
    styles: { width: '100%', 'aspect-ratio': `${w} / ${h}`, 'object-fit': 'cover' },
  });
  return {
    ops: [{ type: 'createNode', parentId: input.nodeId, node: img }],
    src,
    nodeId: img.id,
    where,
  };
}
