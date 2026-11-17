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
import { getNode, topLevel } from '../model/tree';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import type { MenuItem } from '../ui/overlays';

export function buildNodeMenu(): MenuItem[] {
  const doc = useDoc.getState().doc;
  const sel = doc ? topLevel(doc, useUi.getState().selection) : [];
  const nodes = doc ? sel.map((id) => getNode(doc, id)!).filter(Boolean) : [];
  const none = nodes.length === 0;
  const allHidden = nodes.length > 0 && nodes.every((n) => n.hidden);
  const allLocked = nodes.length > 0 && nodes.every((n) => n.locked);
  const one = doc && sel.length === 1 ? sel[0]! : null;
  const instance = one && nodes[0]?.componentId !== undefined ? one : null;
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
