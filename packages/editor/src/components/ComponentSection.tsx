/**
 * "Component" section of the properties panel in main component edit mode: name, description and
 * the list of props (add, remove, rename, type, default and options), via `updateComponent`.
 */
import { useContext } from 'react';
import { Component, Plus, Trash2 } from 'lucide-react';
import { listInstances } from '@mockup/core';
import type { ComponentDef, PropDef, PropType, PropValue } from '@mockup/core';
import { LockedContext } from '../properties/styleOps';
import { IconButton, Row, Section, SelectInput, TextInput } from '../ui/controls';
import { useDoc } from '../state/docStore';
import { updateComponent } from './componentActions';
import { PropControl } from './InstanceSection';
import './components.css';

const TYPES: { value: PropType; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'enum', label: 'Options' },
  { value: 'color', label: 'Color' },
  { value: 'slot', label: 'Slot' },
];

/** Default consistent with the type (when changing the type of a prop). */
function defaultFor(type: PropType, options?: string[]): PropValue | undefined {
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return options?.[0] ?? '';
    case 'slot':
      return undefined;
    case 'color':
      return '#000000';
    default:
      return '';
  }
}

/** Free name `prop`, `prop2`... */
export function nextPropName(props: readonly PropDef[]): string {
  const taken = new Set(props.map((p) => p.name));
  if (!taken.has('prop')) return 'prop';
  for (let i = 2; ; i++) if (!taken.has(`prop${i}`)) return `prop${i}`;
}

/** New props list with prop `i` replaced by `next` (`null` removes). */
export function replaceProp(props: readonly PropDef[], i: number, next: PropDef | null): PropDef[] {
  const out = [...props];
  if (next) out[i] = next;
  else out.splice(i, 1);
  return out;
}

/** Changes the type keeping what makes sense (enum options, converted default). */
export function withType(p: PropDef, type: PropType): PropDef {
  const out: PropDef = { name: p.name, type };
  if (p.description) out.description = p.description;
  if (type === 'enum') {
    out.options = p.options?.length ? [...p.options] : ['a', 'b'];
  }
  const def = defaultFor(type, out.options);
  if (def !== undefined) out.default = def;
  return out;
}

function PropEditor({ def, index }: { def: ComponentDef; index: number }) {
  const p = def.props[index]!;
  const locked = useContext(LockedContext);
  const save = (next: PropDef | null): void => {
    if (locked) return;
    void updateComponent(def.id, { props: replaceProp(def.props, index, next) });
  };
  return (
    <div data-testid={`component-prop-${p.name}`}>
      <div className="cmp-prop-row">
        <TextInput
          value={p.name}
          title="Name (use {{name}} in texts, attributes and styles of the main component)"
          onCommit={(v) => v.trim() && save({ ...p, name: v.trim() })}
        />
        <SelectInput
          value={p.type}
          options={TYPES}
          title="Type"
          onChange={(v) => v && save(withType(p, v as PropType))}
        />
        <IconButton
          title="Remove prop"
          data-testid={`component-prop-remove-${p.name}`}
          onClick={() => save(null)}
        >
          <Trash2 size={12} />
        </IconButton>
      </div>
      <div className="cmp-prop-detail">
        {p.type === 'enum' && (
          <Row label="Options">
            <TextInput
              value={(p.options ?? []).join(', ')}
              placeholder="a, b, c"
              onCommit={(v) => {
                const options = v
                  .split(',')
                  .map((o) => o.trim())
                  .filter(Boolean);
                if (!options.length) return;
                const keep = options.includes(String(p.default)) ? p.default : options[0];
                save({ ...p, options, default: keep });
              }}
            />
          </Row>
        )}
        {p.type === 'slot' ? (
          <div className="cmp-hint">
            Mark a container of the main component with data-slot="{p.name}" (Attributes).
          </div>
        ) : (
          <Row label="Default">
            <PropControl prop={p} value={p.default} onChange={(v) => save({ ...p, default: v })} />
          </Row>
        )}
      </div>
    </div>
  );
}

export function ComponentSection({ def }: { def: ComponentDef }) {
  const locked = useContext(LockedContext);
  const count = useDoc((s) => {
    const raw = s.rawDoc ?? s.doc;
    return raw ? listInstances(raw, def.id).filter((r) => r.pageId).length : 0;
  });
  return (
    <Section
      id="props-component"
      title="Component"
      actions={
        <IconButton
          title="Add prop"
          data-testid="component-prop-add"
          disabled={locked}
          onClick={() => {
            const name = nextPropName(def.props);
            void updateComponent(def.id, {
              props: [...def.props, { name, type: 'string', default: '' }],
            });
          }}
        >
          <Plus size={12} />
        </IconButton>
      }
    >
      <div className="prop-fieldset" data-testid="component-section">
        <div className="cmp-section-head">
          <Component size={14} />
          <span className="cmp-section-name">{def.name}</span>
          <span className="cmp-kit">{count === 1 ? '1 instance' : `${count} instances`}</span>
        </div>
        <Row label="Name">
          <TextInput
            value={def.name}
            onCommit={(v) => v.trim() && void updateComponent(def.id, { name: v.trim() })}
          />
        </Row>
        <Row label="Description">
          <TextInput
            value={def.description ?? ''}
            placeholder="For the panel and for agents"
            onCommit={(v) => void updateComponent(def.id, { description: v.trim() || null })}
          />
        </Row>
        {def.props.length === 0 && (
          <div className="cmp-hint">
            No props. Use + to add and {'{{name}}'} in the main component.
          </div>
        )}
        {def.props.map((p, i) => (
          <PropEditor key={`${i}:${p.name}`} def={def} index={i} />
        ))}
      </div>
    </Section>
  );
}
