/** Remix: gera variações de um nó lado a lado (cada remix = uma entrada de undo). */
import type { RemixKind } from '@mockup/core';
import { isVirtualId } from '@mockup/core';
import { daemon } from '../client/daemon';
import { COMPONENT_FRAME_ID } from '../components/model';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { prompt } from '../ui/overlays';

export const REMIX_DEFAULT_COUNT = 3;
export const REMIX_MAX_COUNT = 10;

export const REMIX_LABELS: Record<Exclude<RemixKind, 'ai'>, string> = {
  'color-scale': 'Remix: escala de cor',
  'font-pairs': 'Remix: pares de fontes',
  spacing: 'Remix: espaçamento',
  layout: 'Remix: layout',
};

/** Nó que o remix usaria: exatamente 1 selecionado, real (não instância expandida). */
export function remixTarget(selection: readonly string[]): string | null {
  if (selection.length !== 1) return null;
  const id = selection[0]!;
  if (isVirtualId(id) || id === COMPONENT_FRAME_ID) return null;
  return id;
}

export function parseCount(raw: string | undefined): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return REMIX_DEFAULT_COUNT;
  return Math.min(n, REMIX_MAX_COUNT);
}

/** Executa o remix do nó selecionado e enquadra os frames criados. */
export async function runRemix(
  kind: RemixKind,
  opts: { count?: number; prompt?: string } = {},
): Promise<void> {
  const nodeId = remixTarget(useUi.getState().selection);
  const docId = useDoc.getState().activeDocId;
  if (!nodeId || !docId) return;
  if (kind === 'ai') {
    // O progresso (texto e ferramentas do turno) aparece no Assistente.
    ui.setRightTab('assistant');
    ui.toast('Remix com IA em andamento…');
  }
  try {
    const res = await daemon.remix(nodeId, kind, { ...opts, docId });
    if (res.frameIds.length > 0) {
      // O daemon já selecionou os frames criados; garante seleção e enquadramento locais.
      ui.select(res.frameIds);
      ui.focus(res.frameIds);
      ui.toast(
        `${res.frameIds.length} ${res.frameIds.length === 1 ? 'variação criada' : 'variações criadas'} — Ctrl+Z desfaz tudo`,
      );
    } else if (kind === 'ai') {
      ui.toast('Remix com IA concluído');
    }
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/** "Remix com IA…": pergunta o pedido e a quantidade de variações. */
export async function runAiRemix(): Promise<void> {
  const r = await prompt({
    title: 'Remix com IA',
    message: 'Descreva como as variações devem diferir do nó selecionado.',
    fields: [
      {
        name: 'prompt',
        label: 'Pedido',
        placeholder: 'ex.: versões mais ousadas, com mais contraste',
      },
      { name: 'count', label: 'Quantidade de variações', value: String(REMIX_DEFAULT_COUNT) },
    ],
    confirmLabel: 'Gerar',
  });
  const text = r?.prompt?.trim();
  if (!r || !text) return;
  await runRemix('ai', { prompt: text, count: parseCount(r.count) });
}
