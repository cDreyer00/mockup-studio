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

  it('has the five items, the first with a separator', () => {
    const items = remixItems();
    expect(items.map((i) => i.label)).toEqual([
      'Remix: color scale',
      'Remix: font pairs',
      'Remix: spacing',
      'Remix: layout',
      'Remix with AI…',
    ]);
    expect(items[0]!.separator).toBe(true);
  });

  it('disabled with no selection and with more than one node', () => {
    const { doc, a, b } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
    useUi.setState({ selection: [] });
    expect(remixItems().every((i) => i.disabled)).toBe(true);
    useUi.setState({ selection: [a.id, b.id] });
    expect(remixItems().every((i) => i.disabled)).toBe(true);
  });

  it('enabled with exactly one real node; disabled on a virtual instance id', () => {
    const { doc, a } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
    useUi.setState({ selection: [a.id] });
    expect(remixItems().every((i) => !i.disabled)).toBe(true);
    useUi.setState({ selection: ['in_x/' + a.id] });
    expect(remixItems().every((i) => i.disabled)).toBe(true);
  });

  it('selecting the item calls daemon.remix with the node and the kind', async () => {
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

  it('daemon error becomes an error toast', async () => {
    const { doc, a } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
    useUi.setState({ selection: [a.id], toast: null });
    vi.spyOn(daemon, 'remix').mockRejectedValue(new Error('Node has no color style'));
    remixItems()[1]!.onSelect!();
    await vi.waitFor(() => expect(useUi.getState().toast?.kind).toBe('error'));
    expect(useUi.getState().toast?.text).toBe('Node has no color style');
  });
});
