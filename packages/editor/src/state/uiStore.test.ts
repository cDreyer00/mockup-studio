import { afterEach, describe, expect, it } from 'vitest';
import { ui, useUi } from './uiStore';

afterEach(() => useUi.setState({ preview: {} }));

describe('releasePreview', () => {
  it('remove só a prévia do próprio gesto, mesmo se outro gesto começou antes do ack', () => {
    const first = { a: { position: { x: 1, y: 1 } } };
    ui.setPreview(first);
    // gesto novo (antes do ack do primeiro) define a própria prévia, inclusive no mesmo nó
    const second = { a: { position: { x: 9, y: 9 } }, b: { style: { opacity: '0.5' } } };
    ui.setPreview(second);
    ui.releasePreview(first);
    expect(useUi.getState().preview).toBe(second);
    ui.releasePreview(second);
    expect(useUi.getState().preview).toEqual({});
  });

  it('mantém entradas de outros nós', () => {
    const mine = { a: { style: { left: '1px' } } };
    const other = { style: { top: '2px' } };
    useUi.setState({ preview: { ...mine, b: other } });
    ui.releasePreview(mine);
    expect(useUi.getState().preview).toEqual({ b: other });
  });
});
