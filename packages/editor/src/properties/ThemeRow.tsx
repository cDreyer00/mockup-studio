/** Linha "Tema" do painel de propriedades: `data-theme` do nó (frame ou qualquer elemento). */
import { THEME_ATTR, effectiveTheme, planSetFrameTheme } from '@mockup/core';
import type { Node } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { Row, SelectInput } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import { common, runOps } from './shared';

export function ThemeRow({ nodes }: { nodes: readonly Node[] }) {
  const themes = useDoc((s) => s.doc?.themes);
  // Tema efetivo (herdado do ancestral mais próximo) quando um único nó não declara o seu.
  const inherited = useDoc((s) => {
    const only = nodes.length === 1 ? nodes[0] : undefined;
    return s.doc && only ? effectiveTheme(s.doc, only.id) : undefined;
  });
  const declared = common(nodes, (n) => n.attrs?.[THEME_ATTR]);
  const known = (themes ?? []).some((t) => t.name === declared);
  const options: SelectOption[] = (themes ?? []).map((t) => ({ value: t.name, label: t.name }));

  const change = (theme: string) => {
    const doc = useDoc.getState().doc;
    if (!doc) return;
    try {
      void runOps(
        planSetFrameTheme(
          doc,
          nodes.map((n) => n.id),
          theme === '' ? null : theme,
        ),
      );
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const placeholder = inherited && !known ? `Herdado (${inherited})` : 'Padrão (base)';
  return (
    <Row label="Tema">
      <div className="prop-theme" data-testid="prop-theme">
        <SelectInput
          value={declared === null ? null : known ? declared : ''}
          options={options}
          placeholder={placeholder}
          title={
            (themes?.length ?? 0) === 0
              ? 'Crie temas na aba Tokens'
              : 'Tema do elemento (data-theme); vazio herda do ancestral'
          }
          onChange={change}
        />
      </div>
    </Row>
  );
}
