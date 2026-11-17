import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SnapshotCore from '@mockup/snapshot-core';

const planCleanup = vi.hoisted(() => vi.fn());
vi.mock('@mockup/snapshot-core', async (orig) => ({
  ...(await orig<typeof SnapshotCore>()),
  planCleanup,
}));

import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { canSimplify, cleanupSummary, simplifyImport } from './simplify';

describe('simplifyImport', () => {
  let apply: ReturnType<typeof vi.spyOn>;
  const frameId = () => useDoc.getState().doc!.pages[0]!.frames[0]!.id;
  beforeEach(() => {
    useDoc.setState({ doc: makeDoc().doc, activeDocId: 'd' });
    useUi.setState({ toast: null });
    apply = vi.spyOn(daemon, 'apply').mockResolvedValue({ revision: 2, results: [] });
  });
  afterEach(() => {
    apply.mockRestore();
    planCleanup.mockReset();
    useDoc.setState({ doc: null, activeDocId: null });
  });

  it('aplica as ops do plano numa única chamada e resume no toast', async () => {
    const ops = [
      { type: 'deleteNodes', nodeIds: ['x'] },
      { type: 'deleteNodes', nodeIds: ['y'] },
    ];
    planCleanup.mockReturnValue({ ops, removed: 2, unwrapped: 1, fluid: 3 });
    await simplifyImport(frameId());
    expect(planCleanup).toHaveBeenCalledWith(useDoc.getState().doc, frameId());
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(ops);
    expect(useUi.getState().toast?.text).toBe(
      'Simplificado: 2 wrappers removidos, 1 desembrulhados, 3 tamanhos fluidos',
    );
  });

  it('sem ops: não chama apply e avisa', async () => {
    planCleanup.mockReturnValue({ ops: [], removed: 0, unwrapped: 0, fluid: 0 });
    await simplifyImport(frameId());
    expect(apply).not.toHaveBeenCalled();
    expect(useUi.getState().toast?.text).toBe('Nada a simplificar');
  });

  it('erro do planejador vira toast, sem propagar', async () => {
    planCleanup.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(simplifyImport(frameId())).resolves.toBeUndefined();
    expect(useUi.getState().toast).toMatchObject({ kind: 'error' });
    expect(useUi.getState().toast?.text).toContain('boom');
  });

  it('canSimplify exige nó com filhos', () => {
    const m = makeDoc();
    useDoc.setState({ doc: m.doc });
    expect(canSimplify(m.frame.id)).toBe(true);
    expect(canSimplify(m.a.id)).toBe(false);
    expect(canSimplify(undefined)).toBe(false);
    expect(cleanupSummary({ removed: 0, unwrapped: 0, fluid: 0 })).toBe('Nada a simplificar');
  });
});
