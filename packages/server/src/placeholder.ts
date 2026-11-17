/**
 * SVG placeholders on a node: swaps the `src` of an image or creates an image inside a container.
 * Shared by the MCP tool `generate_placeholder` and the editor's HTTP route.
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
  /** Applied `src` value (path relative to `assets/` or data URL). */
  src: string;
  /** Id of the node with the placeholder (the created `img`, when the target was a container). */
  nodeId: string;
  /** Description of where the SVG ended up. */
  where: string;
}

/** Writes the SVG to `assets/placeholders/` (reuses an identical one, never overwrites a different one). */
async function storeSvg(assetsDir: string, fileName: string, svg: string): Promise<string> {
  const dir = path.join(assetsDir, 'placeholders');
  const bytes = Buffer.from(svg, 'utf8');
  try {
    const existing = await fs.promises.readFile(path.join(dir, fileName));
    if (existing.equals(bytes)) return `placeholders/${fileName}`;
  } catch {
    // does not exist yet
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
      `Invalid kind: "${String(input.kind)}". Use ${PLACEHOLDER_KINDS.join(', ')}.`,
    );
  }
  const p = findNode(doc, input.nodeId);
  if (!p) {
    throw new PlaceholderError(
      `Node not found: "${input.nodeId}". Use get_tree_summary to list valid ids.`,
    );
  }
  const t = p.node.type;
  if (t === 'text' || t === 'svg') {
    throw new PlaceholderError(
      `Node ${input.nodeId} is ${t}; use an image node (swaps the src) or a container (gets a child image).`,
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
    where = 'embedded data URL (document has no path on disk)';
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
