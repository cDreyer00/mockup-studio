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

  it('applies the plan ops in a single call and summarizes in the toast', async () => {
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
      'Simplified: 2 wrappers removed, 1 unwrapped, 3 fluid sizes',
    );
  });

  it('no ops: does not call apply and notifies', async () => {
    planCleanup.mockReturnValue({ ops: [], removed: 0, unwrapped: 0, fluid: 0 });
    await simplifyImport(frameId());
    expect(apply).not.toHaveBeenCalled();
    expect(useUi.getState().toast?.text).toBe('Nothing to simplify');
  });

  it('planner error becomes a toast, without propagating', async () => {
    planCleanup.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(simplifyImport(frameId())).resolves.toBeUndefined();
    expect(useUi.getState().toast).toMatchObject({ kind: 'error' });
    expect(useUi.getState().toast?.text).toContain('boom');
  });

  it('canSimplify requires a node with children', () => {
    const m = makeDoc();
    useDoc.setState({ doc: m.doc });
    expect(canSimplify(m.frame.id)).toBe(true);
    expect(canSimplify(m.a.id)).toBe(false);
    expect(canSimplify(undefined)).toBe(false);
    expect(cleanupSummary({ removed: 0, unwrapped: 0, fluid: 0 })).toBe('Nothing to simplify');
  });
});
