/**
 * Seção "Instância" do painel de propriedades: componente de origem, um controle por prop (string,
 * number, boolean, enum, color) que gera `setInstanceProps`, slots (seleciona o contêiner) e as
 * ações "Ir para principal", "Destacar", "Restaurar" e "Enviar ao principal".
 */
import { useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpToLine, Component, CornerUpLeft, RotateCcw, Unlink } from 'lucide-react';
import { SLOT_ATTR, isVirtualId } from '@mockup/core';
import type { ComponentDef, Node, PropDef, PropValue } from '@mockup/core';
import { LockedContext } from '../properties/styleOps';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { tokenListFor } from '../tokens/reportCache';
import { ColorInput, Row, Section, SelectInput, TextInput } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import {
  componentOfNode,
  detachInstance,
  goToMain,
  instanceOverrides,
  propValueOf,
  pushToMain,
  resetInstance,
  setInstanceProp,
} from './componentActions';
import './components.css';

/** Tokens de cor do documento (`var(--x)`), para o controle de prop `color`. */
function useColorTokens(): string[] {
  const doc = useDoc((s) => s.doc);
  return useMemo(
    () =>
      doc
        ? tokenListFor(doc)
            .tokens.filter((t) => t.group === 'color')
            .map((t) => t.name)
        : [],
    [doc],
  );
}

/** Controle de uma prop conforme o tipo. `onChange` recebe o valor já no tipo da prop. */
export function PropControl({
  prop,
  value,
  onChange,
  colorTokens = [],
}: {
  prop: PropDef;
  value: PropValue | undefined;
  onChange: (value: PropValue) => void;
  colorTokens?: string[];
}) {
  const locked = useContext(LockedContext);
  const text = value === undefined ? '' : String(value);
  switch (prop.type) {
    case 'number':
      return (
        <NumberInput
          value={text}
          unit=""
          disabled={locked}
          onCommit={(v) => onChange(v.trim() === '' ? (prop.default ?? 0) : Number(v))}
        />
      );
    case 'boolean':
      return (
        <label className="cmp-toggle">
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
            disabled={locked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{value === true || value === 'true' ? 'Sim' : 'Não'}</span>
        </label>
      );
    case 'enum':
      return (
        <SelectInput
          value={text}
          options={(prop.options ?? []).map((o) => ({ value: o, label: o }))}
          placeholder="(padrão)"
          onChange={(v) => onChange(v === '' ? (prop.default ?? prop.options?.[0] ?? '') : v)}
        />
      );
    case 'color':
      return (
        <div className="cmp-color">
          <ColorInput value={text} onCommit={(v) => onChange(v)} />
          {colorTokens.length > 0 && (
            <SelectInput
              value=""
              title="Usar um token de cor"
              placeholder="Token"
              options={colorTokens.map((t) => ({ value: `var(${t})`, label: t }))}
              onChange={(v) => v && onChange(v)}
            />
          )}
        </div>
      );
    default:
      return <TextInput value={text} onCommit={(v) => onChange(v)} />;
  }
}

function ActionButton({
  icon,
  label,
  title,
  disabled,
  testId,
  onClick,
  primary,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  disabled?: boolean;
  testId: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`cmp-btn${primary ? ' primary' : ''}`}
      title={title}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Contêineres de slot reais da instância (nome do slot → id), na ordem do principal. */
function slotContainers(def: ComponentDef, node: Node): { slot: string; id: string }[] {
  const slots = def.props.filter((p) => p.type === 'slot').map((p) => p.name);
  const found = new Map<string, string>();
  const visit = (n: Node): void => {
    const s = n.attrs[SLOT_ATTR];
    if (s && slots.includes(s) && !isVirtualId(n.id) && !found.has(s)) found.set(s, n.id);
    else for (const c of n.children) if (isVirtualId(c.id) || c.attrs[SLOT_ATTR]) visit(c);
  };
  node.children.forEach(visit);
  return slots.flatMap((slot) => (found.has(slot) ? [{ slot, id: found.get(slot)! }] : []));
}

export function InstanceSection({ node }: { node: Node }) {
  const raw = useDoc((s) => s.rawDoc ?? s.doc);
  const def = componentOfNode(raw, node);
  const colorTokens = useColorTokens();
  const locked = useContext(LockedContext);
  const virtual = isVirtualId(node.id);
  const overrides = Object.keys(instanceOverrides(raw, node.id)).length;

  if (!def) {
    return (
      <Section id="props-instance" title="Instância">
        <div className="cmp-hint" data-testid="instance-missing">
          Componente ausente ({node.componentId}).
        </div>
      </Section>
    );
  }
  const props = def.props.filter((p) => p.type !== 'slot');
  const slots = slotContainers(def, node);
  return (
    <Section id="props-instance" title="Instância">
      <div className="prop-fieldset" data-testid="instance-section">
        <div className="cmp-section-head">
          <Component size={14} />
          <span className="cmp-section-name" data-testid="instance-component-name">
            {def.name}
          </span>
          {def.kit && <span className="cmp-kit">{def.kit}</span>}
        </div>
        {props.map((p) => (
          <Row key={p.name} label={p.name}>
            <div
              className="prop-field"
              data-testid={`instance-prop-${p.name}`}
              title={p.description}
            >
              <PropControl
                prop={p}
                value={propValueOf(node, p)}
                colorTokens={colorTokens}
                onChange={(v) => {
                  if (!locked) void setInstanceProp(node.id, p, v);
                }}
              />
            </div>
          </Row>
        ))}
        {slots.length > 0 && (
          <Row label="Slots">
            <div className="cmp-slots">
              {slots.map((s) => (
                <button
                  key={s.slot}
                  type="button"
                  className="cmp-slot"
                  data-testid={`instance-slot-${s.slot}`}
                  title="Selecionar o conteúdo do slot"
                  onClick={() => ui.select([s.id])}
                >
                  {s.slot}
                </button>
              ))}
            </div>
          </Row>
        )}
        <div className="cmp-actions">
          <ActionButton
            primary
            icon={<CornerUpLeft size={12} />}
            label="Ir para principal"
            title="Editar o principal (as mudanças valem para todas as instâncias)"
            testId="instance-go-main"
            onClick={() => goToMain(node.id)}
          />
          <ActionButton
            icon={<Unlink size={12} />}
            label="Destacar"
            title="Transformar a instância em nós comuns"
            testId="instance-detach"
            disabled={virtual || locked}
            onClick={() => void detachInstance(node.id)}
          />
          <ActionButton
            icon={<RotateCcw size={12} />}
            label="Restaurar"
            title={
              overrides
                ? `Remover ${overrides === 1 ? 'a sobrescrita' : `as ${overrides} sobrescritas`} da instância`
                : 'A instância não tem sobrescritas'
            }
            testId="instance-reset"
            disabled={virtual || locked || overrides === 0}
            onClick={() => void resetInstance(node.id)}
          />
          <ActionButton
            icon={<ArrowUpToLine size={12} />}
            label="Enviar ao principal"
            title="Gravar as sobrescritas desta instância no principal"
            testId="instance-push"
            disabled={virtual || locked || overrides === 0}
            onClick={() => void pushToMain(node.id)}
          />
        </div>
      </div>
    </Section>
  );
}
