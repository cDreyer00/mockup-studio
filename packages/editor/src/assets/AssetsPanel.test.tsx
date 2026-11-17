// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetInfo } from '../client/api';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { OverlayHost } from '../ui/overlays';
import { AssetsPanel } from './AssetsPanel';

function asset(path: string, uses = 0): AssetInfo {
  return {
    path,
    name: path,
    ext: '.png',
    kind: 'image',
    mime: 'image/png',
    size: 2048,
    width: 10,
    height: 10,
    mtime: 0,
    hash: `h-${path}`,
    cdnUrl: `http://127.0.0.1:1/cdn/h-${path}.png`,
    uses,
    nodeIds: [],
    refKinds: ['src'],
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('AssetsPanel', () => {
  let calls: { url: string; method: string; body?: string }[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (url === '/api/assets/d1')
        return json({ assets: [asset('used.png', 2), asset('free.png')] });
      if (url.startsWith('/api/assets/d1?path=')) return json({ removed: ['free.png'] });
      if (url.endsWith('/link'))
        return json({ hash: 'h', url: 'http://cdn/x.png', cdnPath: '/cdn/x.png' });
      if (url.startsWith('/api/library')) return json({ assets: [] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    useDoc.setState({
      activeDocId: 'd1',
      documents: [
        { docId: 'd1', name: 'Doc', path: '/tmp/doc.mockup.json', dirty: false, revision: 0 },
      ],
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useUi.setState({ toast: null });
    useDoc.setState({ activeDocId: null, documents: [] });
  });

  it('lista os assets, busca e filtra não usados', async () => {
    render(<AssetsPanel />);
    expect(await screen.findByTestId('asset-item-used.png')).toBeTruthy();
    expect(screen.getByTestId('asset-item-free.png')).toBeTruthy();
    fireEvent.click(screen.getByTestId('assets-unused-filter'));
    expect(screen.queryByTestId('asset-item-used.png')).toBeNull();
    fireEvent.click(screen.getByTestId('assets-unused-filter'));
    fireEvent.change(screen.getByTestId('assets-search'), { target: { value: 'used' } });
    expect(screen.getByTestId('asset-item-used.png')).toBeTruthy();
  });

  it('copia o link do CDN e mostra toast', async () => {
    render(<AssetsPanel />);
    const item = await screen.findByTestId('asset-item-free.png');
    fireEvent.click(within(item).getByTestId('asset-copy-link'));
    await waitFor(() => expect(useUi.getState().toast?.text).toContain('http://cdn/x.png'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://cdn/x.png');
    expect(calls.some((c) => c.url === '/api/assets/d1/link' && c.method === 'POST')).toBe(true);
  });

  it('remove com confirmação (DELETE)', async () => {
    render(
      <>
        <AssetsPanel />
        <OverlayHost />
      </>,
    );
    const item = await screen.findByTestId('asset-item-free.png');
    fireEvent.click(within(item).getByTestId('asset-delete'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Remover'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('path=free.png'))).toBe(
        true,
      ),
    );
    expect(calls.find((c) => c.method === 'DELETE')!.url).not.toContain('force');
  });

  it('asset em uso pede force', async () => {
    render(
      <>
        <AssetsPanel />
        <OverlayHost />
      </>,
    );
    const item = await screen.findByTestId('asset-item-used.png');
    fireEvent.click(within(item).getByTestId('asset-delete'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Remover'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')!.url).toContain('force=1');
  });

  it('documento sem caminho mostra aviso', () => {
    useDoc.setState({
      documents: [{ docId: 'd1', name: 'Doc', path: null, dirty: false, revision: 0 }],
    });
    render(<AssetsPanel />);
    expect(screen.getByText('Salve o documento para gerenciar assets')).toBeTruthy();
  });
});
