/**
 * Leitura e render de componentes no daemon: resolve ids que não existem como nós "soltos" nas
 * páginas (ids virtuais `in_x/caminho`, nós da árvore de um principal e `cp_...`) e monta os
 * documentos que o render e os exportadores consomem (instâncias já expandidas).
 */
import {
  COMPONENT_EDIT_PAGE_ID,
  createNodeFromTag,
  expandDocument,
  expandNodeTree,
  findComponentNode,
  findNode,
  getComponent,
  instanceNodeFor,
  type ComponentDef,
  type Document,
  type NodePath,
} from '@mockup/core';

const tempDocs = new WeakMap<Document, Map<string, Document>>();

/**
 * Documento temporário só para LER a árvore de um principal: uma página com a raiz do principal
 * (instâncias aninhadas expandidas, `{{prop}}` intactos). Cache por documento.
 */
export function componentTempDoc(doc: Document, def: ComponentDef): Document {
  let byId = tempDocs.get(doc);
  if (!byId) {
    byId = new Map();
    tempDocs.set(doc, byId);
  }
  const hit = byId.get(def.id);
  if (hit) return hit;
  const temp: Document = {
    ...doc,
    pages: [
      {
        id: COMPONENT_EDIT_PAGE_ID,
        name: `Principal ${def.name}`,
        background: '#ffffff',
        frames: [expandNodeTree(doc, def.root)],
      },
    ],
  };
  byId.set(def.id, temp);
  return temp;
}

export interface ReadResolution {
  path: NodePath;
  /** Documento em que `path` vive: o expandido, ou o temporário de um principal. */
  doc: Document;
  /** Principal dono do nó, quando o id é de um nó da árvore de um principal. */
  component?: ComponentDef;
}

/**
 * Acha o nó para LEITURA: primeiro no documento expandido (nós reais, instâncias expandidas e ids
 * virtuais), depois entre os nós da árvore de um principal.
 */
export function resolveRead(doc: Document, id: string): ReadResolution | undefined {
  const expanded = expandDocument(doc);
  const p = findNode(expanded, id);
  if (p) return { path: p, doc: expanded };
  // `cp_...` vale como a raiz do principal
  const nodeId = getComponent(doc, id)?.root.id ?? id;
  const c = findComponentNode(doc, nodeId);
  if (!c) return undefined;
  const temp = componentTempDoc(doc, c.component);
  const path = findNode(temp, nodeId);
  return path ? { path, doc: temp, component: c.component } : undefined;
}

/**
 * Documento em que os nós `ids` existem, para quem monta ops lendo o nó (dados, placeholder,
 * contornos, booleanas): o próprio documento (nós reais), o expandido (ids virtuais `in_x/...`;
 * as ops roteiam para overrides) ou o temporário de um principal (as ops editam o principal).
 */
export function docWithNodes(doc: Document, ids: readonly string[]): Document {
  if (ids.every((id) => findNode(doc, id))) return doc;
  const expanded = expandDocument(doc);
  const missing = ids.find((id) => !findNode(expanded, id));
  if (missing === undefined) return expanded;
  return resolveRead(doc, missing)?.doc ?? doc;
}

const PREVIEW_INSTANCE_ID = 'in_preview0';
const PREVIEW_FRAME_ID = 'fr_preview0';

/**
 * Documento de prévia de um principal: uma página com um frame contendo uma instância padrão
 * (props padrão, slots vazios), já expandido. `instanceId` é o id da instância na prévia.
 */
export function componentPreviewDoc(
  doc: Document,
  def: ComponentDef,
): { doc: Document; instanceId: string } {
  const instance = instanceNodeFor(doc, def.id, { id: PREVIEW_INSTANCE_ID });
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: `Prévia ${def.name}`,
    styles: {
      width: '960px',
      display: 'flex',
      'flex-direction': 'column',
      'align-items': 'flex-start',
      padding: '24px',
      background: '#ffffff',
    },
    position: { x: 0, y: 0 },
  });
  frame.id = PREVIEW_FRAME_ID;
  frame.children = [instance];
  const preview: Document = {
    ...doc,
    pages: [{ id: 'pg_preview', name: 'Prévia', background: '#ffffff', frames: [frame] }],
  };
  return { doc: expandDocument(preview), instanceId: PREVIEW_INSTANCE_ID };
}

export interface RenderTarget {
  /** Documento a entregar ao `RenderProvider` (instâncias expandidas). */
  doc: Document;
  nodeId: string;
  name: string;
}

/**
 * Alvo de screenshot/medição: nós reais e ids virtuais saem do documento expandido; um principal
 * (`cp_...`) ou um nó da sua árvore é renderizado numa instância padrão num documento temporário.
 */
export function renderTargetFor(doc: Document, ref: string): RenderTarget | undefined {
  const expanded = expandDocument(doc);
  const p = findNode(expanded, ref);
  if (p) return { doc: expanded, nodeId: ref, name: p.node.name };
  const def = getComponent(doc, ref);
  if (def) {
    const prev = componentPreviewDoc(doc, def);
    return { doc: prev.doc, nodeId: prev.instanceId, name: def.name };
  }
  const c = findComponentNode(doc, ref);
  if (!c) return undefined;
  const prev = componentPreviewDoc(doc, c.component);
  return {
    doc: prev.doc,
    nodeId: c.parent ? `${prev.instanceId}/${ref}` : prev.instanceId,
    name: c.node.name,
  };
}
