import { afterEach, describe, expect, it } from 'vitest';
import { ui, useUi } from './uiStore';

afterEach(() => useUi.setState({ preview: {} }));

describe('releasePreview', () => {
  it('removes only the preview of its own gesture, even if another gesture started before the ack', () => {
    const first = { a: { position: { x: 1, y: 1 } } };
    ui.setPreview(first);
    // a new gesture (before the first one's ack) sets its own preview, including on the same node
    const second = { a: { position: { x: 9, y: 9 } }, b: { style: { opacity: '0.5' } } };
    ui.setPreview(second);
    ui.releasePreview(first);
    expect(useUi.getState().preview).toBe(second);
    ui.releasePreview(second);
    expect(useUi.getState().preview).toEqual({});
  });

  it('keeps entries of other nodes', () => {
    const mine = { a: { style: { left: '1px' } } };
    const other = { style: { top: '2px' } };
    useUi.setState({ preview: { ...mine, b: other } });
    ui.releasePreview(mine);
    expect(useUi.getState().preview).toEqual({ b: other });
  });
});
