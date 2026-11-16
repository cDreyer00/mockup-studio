import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Node } from '@mockup/core';
import { ui } from '../state/uiStore';
import { IconButton, Row, SelectInput, Section } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import { Body, DraftInput, StyleSelect, common, runOps } from './shared';
import type { NodeCtx } from './shared';

const COMMON_TAGS = [
  'div',
  'section',
  'header',
  'footer',
  'nav',
  'main',
  'article',
  'aside',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'a',
  'button',
  'ul',
  'ol',
  'li',
  'label',
  'input',
  'textarea',
  'form',
  'img',
];
const ROOT_TAGS = ['div', 'section', 'main'];
const FORBIDDEN_ATTRS = new Set(['class', 'style']);
/** Atributos com campo dedicado (não entram na lista genérica). */
const DEDICATED = new Set(['id', 'href', 'alt', 'placeholder', 'type']);

const toOptions = (tags: string[]): SelectOption[] => tags.map((t) => ({ value: t, label: t }));
const OBJECT_FIT: SelectOption[] = ['cover', 'contain', 'fill', 'none', 'scale-down'].map((v) => ({
  value: v,
  label: v,
}));

function setAttr(nodes: readonly Node[], key: string, value: string): void {
  if (FORBIDDEN_ATTRS.has(key)) {
    ui.toast(`O atributo "${key}" não pode ser editado aqui (use o CSS).`, 'error');
    return;
  }
  const v = value.trim();
  void runOps([
    {
      type: 'setAttrs',
      changes: nodes.map((n) => ({
        nodeId: n.id,
        ...(v === '' ? { unset: [key] } : { set: { [key]: v } }),
      })),
    },
  ]);
}

function AttrField({
  nodes,
  name,
  label,
  placeholder,
}: {
  nodes: readonly Node[];
  name: string;
  label: string;
  placeholder?: string;
}) {
  return (
    <Row label={label}>
      <DraftInput
        value={common(nodes, (n) => n.attrs[name])}
        placeholder={placeholder}
        onCommit={(v) => setAttr(nodes, name, v)}
      />
    </Row>
  );
}

function GenericAttrs({ node }: { node: Node }) {
  const [key, setKey] = useState('');
  const [val, setVal] = useState('');
  const entries = Object.entries(node.attrs).filter(([k]) => !DEDICATED.has(k));
  const add = () => {
    const k = key.trim();
    if (!k) return;
    if (!/^[a-zA-Z_:][\w:.-]*$/.test(k))
      return ui.toast(`Nome de atributo inválido: "${k}"`, 'error');
    setAttr([node], k, val === '' ? ' ' : val);
    if (!FORBIDDEN_ATTRS.has(k)) {
      setKey('');
      setVal('');
    }
  };
  return (
    <div className="prop-attrs">
      {entries.map(([k, v]) => (
        <div className="prop-attr" key={k}>
          <span className="prop-attr-key mono" title={k}>
            {k}
          </span>
          <DraftInput value={v} mono onCommit={(nv) => setAttr([node], k, nv)} />
          <IconButton title={`Remover ${k}`} onClick={() => setAttr([node], k, '')}>
            <X size={12} />
          </IconButton>
        </div>
      ))}
      <div className="prop-attr">
        <input
          className="text-input mono"
          placeholder="atributo"
          value={key}
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
            e.stopPropagation();
          }}
        />
        <input
          className="text-input mono"
          placeholder="valor"
          value={val}
          spellCheck={false}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
            e.stopPropagation();
          }}
        />
        <IconButton title="Adicionar atributo" onClick={add}>
          <Plus size={12} />
        </IconButton>
      </div>
    </div>
  );
}

export function AttrsSection({ ctxs }: { ctxs: readonly NodeCtx[] }) {
  const nodes = ctxs.map((c) => c.node);
  const tag = common(nodes, (n) => n.tag);
  const allRoot = ctxs.every((c) => c.isRoot);
  const fixedTag = nodes.some((n) => n.type === 'image' || n.type === 'svg');
  const all = (pred: (t: string) => boolean) => nodes.every((n) => pred(n.tag));
  const options = toOptions(allRoot ? ROOT_TAGS : COMMON_TAGS);

  const setTag = (t: string) => {
    const v = t.trim().toLowerCase();
    if (!v || v === tag) return;
    if (!/^[a-z][a-z0-9-]*$/.test(v)) return ui.toast(`Tag inválida: "${t}"`, 'error');
    void runOps([{ type: 'setTag', changes: nodes.map((n) => ({ nodeId: n.id, tag: v })) }]);
  };

  return (
    <Section id="props-attrs" title="Tag e atributos" defaultOpen={false}>
      <Body>
        <Row label="Tag">
          <div className="prop-tag" data-testid="prop-tag">
            <SelectInput value={tag} options={options} title="Tag HTML" onChange={setTag} />
            {!fixedTag && !allRoot && (
              <DraftInput value="" placeholder="outra…" mono onCommit={setTag} />
            )}
          </div>
        </Row>
        <AttrField nodes={nodes} name="id" label="ID" />
        {all((t) => t === 'a') && (
          <AttrField nodes={nodes} name="href" label="Href" placeholder="https://" />
        )}
        {all((t) => t === 'img') && <AttrField nodes={nodes} name="alt" label="Alt" />}
        {all((t) => t === 'input' || t === 'textarea') && (
          <AttrField nodes={nodes} name="placeholder" label="Placeholder" />
        )}
        {all((t) => t === 'input' || t === 'button') && (
          <AttrField nodes={nodes} name="type" label="Type" />
        )}
        {nodes.every((n) => n.type === 'image') && (
          <>
            <Row label="Src">
              <DraftInput
                value={common(nodes, (n) => n.src)}
                mono
                placeholder="src"
                onCommit={() => ui.toast('O src da imagem é somente leitura.', 'info')}
              />
            </Row>
            <Row label="Ajuste">
              <StyleSelect
                nodes={nodes}
                prop="object-fit"
                options={OBJECT_FIT}
                title="object-fit"
                placeholder="fill"
              />
            </Row>
          </>
        )}
        {nodes.length === 1 && <GenericAttrs node={nodes[0]!} />}
      </Body>
    </Section>
  );
}
