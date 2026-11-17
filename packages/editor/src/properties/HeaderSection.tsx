import { Frame, Image as ImageIcon, Lock, Repeat, Shapes, Square, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Node, NodeType } from '@mockup/core';
import { Section } from '../ui/controls';
import { runOps, Body, DraftInput, common } from './shared';

const ICONS: Record<NodeType, ReactNode> = {
  frame: <Frame size={14} />,
  element: <Square size={14} />,
  text: <Type size={14} />,
  image: <ImageIcon size={14} />,
  svg: <Shapes size={14} />,
  repeater: <Repeat size={14} />,
};

const TYPE_NAMES: Record<NodeType, string> = {
  frame: 'Frame',
  element: 'Elemento',
  text: 'Texto',
  image: 'Imagem',
  svg: 'SVG',
  repeater: 'Repetidor',
};

export function HeaderSection({ nodes, locked }: { nodes: readonly Node[]; locked: boolean }) {
  const first = nodes[0]!;
  const sameType = nodes.every((n) => n.type === first.type);
  const sameTag = nodes.every((n) => n.tag === first.tag);
  const name = common(nodes, (n) => n.name);
  const subtitle =
    nodes.length > 1
      ? `${nodes.length} itens selecionados`
      : `${TYPE_NAMES[first.type]} · <${first.tag}>`;
  return (
    <Section id="props-header" title={nodes.length > 1 ? 'Seleção' : 'Elemento'}>
      <Body>
        <div className="prop-header">
          <span className="prop-header-icon">
            {sameType ? ICONS[first.type] : <Square size={14} />}
          </span>
          <div className="prop-header-name" data-testid="prop-name">
            <DraftInput
              value={name}
              placeholder="Nome"
              onCommit={(v) => {
                const nm = v.trim();
                if (!nm) return;
                void runOps([
                  { type: 'renameNodes', changes: nodes.map((n) => ({ nodeId: n.id, name: nm })) },
                ]);
              }}
            />
          </div>
        </div>
        <div className="prop-subtitle">
          {locked && <Lock size={10} />}
          <span>
            {nodes.length > 1 && sameType && sameTag ? `${subtitle} · ${first.tag}` : subtitle}
          </span>
        </div>
      </Body>
    </Section>
  );
}
