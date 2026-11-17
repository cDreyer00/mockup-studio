/** "Theme" row of the properties panel: the node's `data-theme` (frame or any element). */
import { THEME_ATTR, effectiveTheme, planSetFrameTheme } from '@mockup/core';
import type { Node } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { Row, SelectInput } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import { common, runOps } from './shared';

export function ThemeRow({ nodes }: { nodes: readonly Node[] }) {
  const themes = useDoc((s) => s.doc?.themes);
  // Effective theme (inherited from the nearest ancestor) when a single node doesn't declare its own.
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

  const placeholder = inherited && !known ? `Inherited (${inherited})` : 'Default (base)';
  return (
    <Row label="Theme">
      <div className="prop-theme" data-testid="prop-theme">
        <SelectInput
          value={declared === null ? null : known ? declared : ''}
          options={options}
          placeholder={placeholder}
          title={
            (themes?.length ?? 0) === 0
              ? 'Create themes in the Tokens tab'
              : 'Element theme (data-theme); empty inherits from the ancestor'
          }
          onChange={change}
        />
      </div>
    </Row>
  );
}
