import { useEffect, useRef } from 'react';
import { useFxClock } from './clock';
import { iframeSandbox } from './iframeSandbox';
import { fxBegin } from './ready';
import { FX_INNER, fxRootStyle } from './types';
import type { FxViewProps } from './types';

const LOAD_TIMEOUT_MS = 5000;

/** `iframe` embed (arbitrary http(s) URL), isolated by `sandbox` and without referrer. */
export function IframeView({ node, style }: FxViewProps) {
  const url = node.embed?.url;
  const render = useFxClock((s) => s.manual) !== null;
  const doneRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!render || !url) return;
    const done = fxBegin(LOAD_TIMEOUT_MS);
    doneRef.current = done;
    return () => {
      doneRef.current = null;
      done();
    };
  }, [render, url]);

  return (
    <div data-node-id={node.id} style={fxRootStyle(style)}>
      {url && (
        <iframe
          src={url}
          title="Iframe"
          sandbox={iframeSandbox(url, window.location.origin)}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{ ...FX_INNER, background: '#fff' }}
          onLoad={() => doneRef.current?.()}
        />
      )}
    </div>
  );
}
