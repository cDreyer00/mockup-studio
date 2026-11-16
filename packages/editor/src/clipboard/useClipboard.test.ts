// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { extractMarker } from './paste';
import { copySelection } from './useClipboard';

function clipboardEvent() {
  const data = new Map<string, string>();
  let prevented = false;
  const e = {
    clipboardData: { setData: (t: string, v: string) => data.set(t, v) },
    preventDefault: () => (prevented = true),
  } as unknown as ClipboardEvent;
  return { e, data, prevented: () => prevented };
}

afterEach(() => {
  useDoc.setState({ doc: null });
  useUi.setState({ selection: [], toast: null });
});

describe('copySelection', () => {
  it('copiar inclui nós travados; recortar deixa os travados de fora', () => {
    const { doc, a, b } = makeDoc();
    b.locked = true;
    useDoc.setState({ doc });
    useUi.setState({ selection: [a.id, b.id] });
    const copy = clipboardEvent();
    expect(copySelection(copy.e)).toBe(true);
    expect(copy.data.get('text/html')).toContain('>b<');
    const cut = clipboardEvent();
    expect(copySelection(cut.e, true)).toBe(true);
    const html = cut.data.get('text/html')!;
    expect(extractMarker(html)).toBeTruthy();
    expect(html).not.toContain('>b<');
  });

  it('recortar só travados não copia nada e avisa', () => {
    const { doc, b } = makeDoc();
    b.locked = true;
    useDoc.setState({ doc });
    useUi.setState({ selection: [b.id] });
    const cut = clipboardEvent();
    expect(copySelection(cut.e, true)).toBe(false);
    expect(cut.data.size).toBe(0);
    expect(cut.prevented()).toBe(true);
    expect(useUi.getState().toast?.text).toContain('travados');
  });
});
