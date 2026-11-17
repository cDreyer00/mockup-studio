import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAsset, toast } = vi.hoisted(() => ({ fetchAsset: vi.fn(), toast: vi.fn() }));
vi.mock('../client/daemon', () => ({ daemon: { fetchAsset } }));
vi.mock('../state/uiStore', () => ({ ui: { toast } }));
vi.mock('../canvas/canvasApi', () => ({ canvasApi: {} }));
vi.mock('../state/docStore', () => ({ useDoc: { getState: () => ({}) } }));
vi.mock('../state/hooks', () => ({ currentPageId: () => null }));
vi.mock('../model/factory', () => ({ makeFrame: () => ({}) }));
vi.mock('../canvas/placement', () => ({ buildCreateOps: () => [], planPlacement: () => ({}) }));
vi.mock('./mediaStore', () => ({ mediaDialogs: {} }));

import { VIDEO_ACCEPT, localizeAnimation } from './mediaFlows';

describe('localizeAnimation', () => {
  beforeEach(() => {
    fetchAsset.mockReset();
    toast.mockReset();
  });

  it('replaces the Lottie/Rive URL with the src copied to assets/', async () => {
    fetchAsset.mockResolvedValueOnce('lottie/a.json');
    const out = await localizeAnimation({ provider: 'lottie', src: 'https://x.dev/a.json' });
    expect(out).toEqual({ provider: 'lottie', src: 'lottie/a.json' });
    expect(fetchAsset).toHaveBeenCalledWith('https://x.dev/a.json', 'lottie');
    fetchAsset.mockResolvedValueOnce('rive/b.riv');
    expect(await localizeAnimation({ provider: 'rive', src: 'https://x.dev/b.riv' })).toEqual({
      provider: 'rive',
      src: 'rive/b.riv',
    });
  });

  it('if the download fails, keeps the URL and warns', async () => {
    fetchAsset.mockRejectedValueOnce(new Error('HTTP 404'));
    const spec = { provider: 'rive', src: 'https://x.dev/b.riv' } as const;
    expect(await localizeAnimation(spec)).toEqual(spec);
    expect(toast).toHaveBeenCalledOnce();
    expect(String(toast.mock.calls[0]![0])).toContain('HTTP 404');
  });

  it('leaves other providers and local paths alone', async () => {
    const yt = { provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' } as const;
    expect(await localizeAnimation(yt)).toBe(yt);
    const local = { provider: 'lottie', src: 'lottie/a.json' } as const;
    expect(await localizeAnimation(local)).toBe(local);
    expect(fetchAsset).not.toHaveBeenCalled();
  });
});

describe('VIDEO_ACCEPT', () => {
  it('matches the MCP set', () => {
    expect(VIDEO_ACCEPT.split(',').sort()).toEqual(['.m4v', '.mov', '.mp4', '.ogv', '.webm']);
  });
});
