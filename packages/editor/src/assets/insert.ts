/**
 * Inserção de um asset já existente no documento como nó `img`: no nó selecionado (se aceita
 * filhos) ou no contêiner sob o ponteiro/centro da tela. Reaproveita `planPlacement`/`buildCreateOps`.
 */
import type { Node, Op } from '@mockup/core';
import { buildCreateOps, planPlacement } from '../canvas/placement';
import { canvasApi } from '../canvas/canvasApi';
import { clientToWorld, getCanvasRoot } from '../canvas/dom';
import { makeFrame, makeImage } from '../model/factory';
import { canHaveChildren, getNode, isLockedDeep } from '../model/tree';
import { daemon } from '../client/daemon';
import type { AssetInfo } from '../client/api';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';

const MAX_IMAGE_W = 800;
const FALLBACK_SIZE = { w: 240, h: 160 };

type InsertableAsset = Pick<AssetInfo, 'path' | 'name' | 'width' | 'height'>;

/** Dimensão inicial: tamanho natural limitado a 800 px de largura. */
export function initialImageSize(a: Pick<AssetInfo, 'width' | 'height'>): { w: number; h: number } {
  const nat = a.width && a.height ? { w: a.width, h: a.height } : FALLBACK_SIZE;
  const k = nat.w > MAX_IMAGE_W ? MAX_IMAGE_W / nat.w : 1;
  return { w: Math.max(1, Math.round(nat.w * k)), h: Math.max(1, Math.round(nat.h * k)) };
}

/** Insere o asset. `client` = ponto da janela (soltar no canvas). Devolve o id do nó ou `null`. */
export async function insertAsset(
  asset: InsertableAsset,
  client?: { x: number; y: number },
): Promise<string | null> {
  try {
    const doc = useDoc.getState().doc;
    const pageId = currentPageId();
    if (!doc || !pageId)
      throw new Error('Nenhum documento aberto. Abra um documento para inserir.');
    const { w, h } = initialImageSize(asset);
    // Mesmo padrão do upload (`imageTool`): caminho relativo a assets/, sem o prefixo.
    const src = asset.path;
    const alt = asset.name.replace(/\.[^.]+$/, '');
    let image: Node;
    let ops: Op[];

    const selectedId = useUi.getState().selection[0];
    const selected = selectedId ? getNode(doc, selectedId) : undefined;
    const root = getCanvasRoot();
    if (!client && selected && canHaveChildren(selected) && !isLockedDeep(doc, selected.id)) {
      image = makeImage(src, { w, h, alt });
      ops = [{ type: 'createNode', parentId: selected.id, node: image }];
    } else {
      const center = canvasApi.viewportCenter();
      const at =
        client && root
          ? clientToWorld(root, client.x, client.y)
          : { x: center.x - w / 2, y: center.y - h / 2 };
      const plan = planPlacement(doc, at, client);
      if (!plan.parentId) {
        image = makeImage(src, { w, h, alt });
        const frame = makeFrame(at.x, at.y, w, h, 'Imagem');
        frame.children.push(image);
        ops = buildCreateOps(pageId, plan, frame);
      } else {
        image = makeImage(src, { w, h, alt, x: plan.x, y: plan.y, absolute: !plan.flow });
        ops = buildCreateOps(pageId, plan, image);
      }
    }
    const ack = await daemon.applySafe(ops);
    if (!ack) return null;
    ui.select([image.id]);
    return image.id;
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error');
    return null;
  }
}

/** Tipo de arrasto usado para soltar um asset no canvas. */
export const ASSET_DRAG_TYPE = 'application/x-mockup-asset';

/** Ouve o drop de assets sobre o canvas (um único listener; devolve a função de remoção). */
export function listenAssetDrops(
  lookup: (path: string) => InsertableAsset | undefined,
): () => void {
  const accepts = (e: DragEvent): boolean =>
    !!e.dataTransfer?.types.includes(ASSET_DRAG_TYPE) &&
    !!getCanvasRoot()?.contains(e.target as globalThis.Node);
  const over = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const drop = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    const path = e.dataTransfer?.getData(ASSET_DRAG_TYPE);
    const asset = path ? lookup(path) : undefined;
    if (asset) void insertAsset(asset, { x: e.clientX, y: e.clientY });
  };
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
  };
}
