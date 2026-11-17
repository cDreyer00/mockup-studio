/**
 * Itens do menu de contexto de nós, compartilhado pelo painel de camadas e pelo canvas.
 * Opera sobre a seleção atual (quem abre o menu seleciona o nó clicado antes, se preciso).
 */
import { actions } from '../actions';
import {
  createComponentBlock,
  createComponentFromSelection,
  detachInstance,
  goToMain,
} from '../components/componentActions';
import { isRealInstance } from '../components/model';
import { REMIX_LABELS, remixTarget, runAiRemix, runRemix } from '../remix/remixActions';
import { convertToRepeater } from '../client/features';
import { getNode, getParent, topLevel } from '../model/tree';
import { canSimplify, simplifyImport } from '../snapshot/simplify';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import type { MenuItem } from '../ui/overlays';
import { booleanOp, flatten, textToOutlines } from '../vector/vectorActions';

export function buildNodeMenu(): MenuItem[] {
  const doc = useDoc.getState().doc;
  const sel = doc ? topLevel(doc, useUi.getState().selection) : [];
  const nodes = doc ? sel.map((id) => getNode(doc, id)!).filter(Boolean) : [];
  const none = nodes.length === 0;
  const allHidden = nodes.length > 0 && nodes.every((n) => n.hidden);
  const convertible =
    !!doc &&
    nodes.length === 1 &&
    nodes[0]!.type === 'element' &&
    nodes[0]!.children.length > 0 &&
    getParent(doc, nodes[0]!.id) !== null;
  const allLocked = nodes.length > 0 && nodes.every((n) => n.locked);
  const one = doc && sel.length === 1 ? sel[0]! : null;
  const remixable = remixTarget(useUi.getState().selection) !== null;
  const instance = one && nodes[0]?.componentId !== undefined ? one : null;
  const svgCount = nodes.filter((n) => n.type === 'svg').length;
  const allSvg = nodes.length > 0 && svgCount === nodes.length;
  const anyText = nodes.some((n) => n.type === 'text');
  const vectorItems: MenuItem[] = [
    ...(allSvg && nodes.length >= 2
      ? ([
          ['union', 'União'],
          ['subtract', 'Subtração'],
          ['intersect', 'Interseção'],
          ['exclude', 'Exclusão'],
        ] as const).map(([op, label], i) => ({
          label,
          separator: i === 0,
          onSelect: () => void booleanOp(op),
        }))
      : []),
    ...(allSvg
      ? [
          {
            label: 'Achatar',
            separator: nodes.length < 2,
            onSelect: () => void flatten(),
          },
        ]
      : []),
    ...(anyText
      ? [
          {
            label: 'Texto em contornos',
            shortcut: 'Ctrl+Shift+O',
            separator: true,
            onSelect: () => void textToOutlines(),
          },
        ]
      : []),
  ];
  return [
    {
      label: 'Criar componente',
      shortcut: 'Ctrl+Alt+K',
      disabled: !one || !doc || createComponentBlock(doc, one) !== null,
      onSelect: () => void createComponentFromSelection(),
    },
    {
      label: 'Ir para principal',
      disabled: !instance,
      onSelect: () => void (instance && goToMain(instance)),
    },
    {
      label: 'Destacar instância',
      disabled: !instance || !doc || !isRealInstance(doc, instance),
      onSelect: () => void (instance && detachInstance(instance)),
    },

    {
      label: 'Duplicar',
      shortcut: 'Ctrl+D',
      separator: true,
      disabled: none,
      onSelect: () => void actions.duplicateSelection(),
    },
    {
      label: 'Agrupar em container',
      shortcut: 'Ctrl+G',
      disabled: none,
      onSelect: () => void actions.group(),
    },
    {
      label: 'Desagrupar',
      shortcut: 'Ctrl+Shift+G',
      disabled: none || nodes.every((n) => n.children.length === 0),
      onSelect: () => void actions.ungroup(),
    },
    {
      label: 'Converter em repetidor',
      disabled: !convertible,
      onSelect: () => void convertToRepeater(sel[0]!),
    },
    {
      label: 'Trazer para frente',
      shortcut: 'Ctrl+Shift+]',
      separator: true,
      disabled: none,
      onSelect: () => void actions.reorder('front'),
    },
    {
      label: 'Avançar',
      shortcut: 'Ctrl+]',
      disabled: none,
      onSelect: () => void actions.reorder('forward'),
    },
    {
      label: 'Recuar',
      shortcut: 'Ctrl+[',
      disabled: none,
      onSelect: () => void actions.reorder('backward'),
    },
    {
      label: 'Enviar para trás',
      shortcut: 'Ctrl+Shift+[',
      disabled: none,
      onSelect: () => void actions.reorder('back'),
    },
    {
      label: allHidden ? 'Mostrar' : 'Ocultar',
      shortcut: 'Ctrl+Shift+H',
      separator: true,
      disabled: none,
      onSelect: () => void actions.setHidden(sel, !allHidden),
    },
    {
      label: allLocked ? 'Destravar' : 'Travar',
      shortcut: 'Ctrl+Shift+L',
      disabled: none,
      onSelect: () => void actions.setLocked(sel, !allLocked),
    },
    ...vectorItems,
    {
      label: 'Simplificar importação',
      separator: true,
      disabled: sel.length !== 1 || !canSimplify(sel[0]),
      onSelect: () => void simplifyImport(sel[0]!),
    },
    {
      label: REMIX_LABELS['color-scale'],
      separator: true,
      disabled: !remixable,
      onSelect: () => void runRemix('color-scale'),
    },
    {
      label: REMIX_LABELS['font-pairs'],
      disabled: !remixable,
      onSelect: () => void runRemix('font-pairs'),
    },
    {
      label: REMIX_LABELS.spacing,
      disabled: !remixable,
      onSelect: () => void runRemix('spacing'),
    },
    {
      label: REMIX_LABELS.layout,
      disabled: !remixable,
      onSelect: () => void runRemix('layout'),
    },
    {
      label: 'Remix com IA…',
      disabled: !remixable,
      onSelect: () => void runAiRemix(),
    },
    {
      label: 'Excluir',
      shortcut: 'Delete',
      separator: true,
      danger: true,
      disabled: none,
      onSelect: () => void actions.deleteSelection(),
    },
  ];
}
