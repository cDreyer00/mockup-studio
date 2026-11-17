import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { buildNodeMenu } from './nodeMenu';

const remixItems = () => buildNodeMenu().filter((i) => i.label.startsWith('Remix'));

describe('nodeMenu: Remix', () => {
  beforeEach(() => {
    const { doc } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useUi.setState({ selection: [] });
  });

  it('tem os cinco itens, o primeiro com separador', () => {
    const items = remixItems();
    expect(items.map((i) => i.label)).toEqual([
      'Remix: escala de cor',
      'Remix: pares de fontes',
      'Remix: espaçamento',
      'Remix: layout',
      'Remix com IA…',
    ]);
    expect(items[0]!.separator).toBe(true);
  });

  it('desabilitados sem seleção e com mais de um nó', () => {
    const { doc, a, b } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
    useUi.setState({ selection: [] });
    expect(remixItems().every((i) => i.disabled)).toBe(true);
    useUi.setState({ selection: [a.id, b.id] });
    expect(remixItems().every((i) => i.disabled)).toBe(true);
  });

  it('habilitados com exatamente um nó real; desabilitados em id virtual de instância', () => {
    const { doc, a } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
    useUi.setState({ selection: [a.id] });
    expect(remixItems().every((i) => !i.disabled)).toBe(true);
    useUi.setState({ selection: ['in_x/' + a.id] });
    expect(remixItems().every((i) => i.disabled)).toBe(true);
  });

  it('selecionar o item chama daemon.remix com o nó e o tipo', async () => {
    const { doc, a } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
    useUi.setState({ selection: [a.id] });
    const spy = vi
      .spyOn(daemon, 'remix')
      .mockResolvedValue({ frameIds: ['f1', 'f2'], labels: ['A', 'B'] });
    remixItems()[0]!.onSelect!();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      a.id,
      'color-scale',
      expect.objectContaining({ docId: doc.id }),
    );
    await vi.waitFor(() => expect(useUi.getState().selection).toEqual(['f1', 'f2']));
    expect(useUi.getState().focusRequest?.nodeIds).toEqual(['f1', 'f2']);
  });

  it('erro do daemon vira toast de erro', async () => {
    const { doc, a } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
    useUi.setState({ selection: [a.id], toast: null });
    vi.spyOn(daemon, 'remix').mockRejectedValue(new Error('Nó sem estilo de cor'));
    remixItems()[1]!.onSelect!();
    await vi.waitFor(() => expect(useUi.getState().toast?.kind).toBe('error'));
    expect(useUi.getState().toast?.text).toBe('Nó sem estilo de cor');
  });
});
