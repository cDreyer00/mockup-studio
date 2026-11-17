import { useContext, useEffect, useMemo, useState } from 'react';
import type { Node } from '@mockup/core';
import { ui } from '../state/uiStore';
import { Section } from '../ui/controls';
import { diffStyles, parseCssText, stylesToCssText } from './css';
import { Body, LockedContext, commitStyles } from './shared';

/** Raw CSS of a single node: diff applied on blur/Ctrl+Enter. */
export function CssSection({ node }: { node: Node }) {
  const locked = useContext(LockedContext);
  const shown = useMemo(() => stylesToCssText(node.style), [node.style]);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused, node.id]);

  const apply = () => {
    if (text === shown) return;
    const parsed = parseCssText(text);
    if (parsed.error) {
      ui.toast(parsed.error, 'error');
      return;
    }
    const { set, unset } = diffStyles(node.style, parsed.style);
    void commitStyles([node], () => ({ set, unset }));
  };

  return (
    <Section id="props-css" title="Advanced CSS" defaultOpen={false}>
      <Body>
        <textarea
          className="mono prop-textarea prop-css"
          data-testid="prop-css"
          value={text}
          rows={8}
          spellCheck={false}
          disabled={locked}
          placeholder="property: value;"
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            apply();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
              (e.target as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      </Body>
    </Section>
  );
}
