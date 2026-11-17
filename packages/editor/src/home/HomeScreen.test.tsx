// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../client/api';
import { HomeScreen } from './HomeScreen';

function file(name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/p/${name}.mockup.json`,
    name,
    folder: null,
    tags: [],
    favorite: false,
    open: false,
    mtime: 1,
    size: 1,
    pages: 1,
    frames: 2,
    ...extra,
  };
}

const ALL = [
  file('alfa', { recent: 0, folder: 'Clientes/Acme', tags: ['site'] }),
  file('beta', { recent: 1 }),
  file('gama', { folder: 'Pessoal', tags: ['ideia'] }),
];

describe('HomeScreen', () => {
  let urls: string[];
  beforeEach(() => {
    urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        const u = new URL(url, 'http://x');
        let files = ALL;
        const folder = u.searchParams.get('folder');
        const tag = u.searchParams.get('tag');
        if (folder) files = files.filter((f) => f.folder?.startsWith(folder));
        if (tag) files = files.filter((f) => f.tags.includes(tag));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              files,
              folders: ['Clientes/Acme', 'Pessoal'],
              tags: ['site', 'ideia'],
            }),
          ),
        );
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('mostra os recentes em ordem e as pastas/tags', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getAllByTestId('file-card')).toHaveLength(2));
    expect(screen.getAllByTestId('file-card').map((c) => c.getAttribute('data-path'))).toEqual([
      '/p/alfa.mockup.json',
      '/p/beta.mockup.json',
    ]);
    expect(screen.getByTestId('home-folder-Clientes')).toBeTruthy();
    expect(screen.getByTestId('home-folder-Clientes/Acme')).toBeTruthy();
    expect(screen.getByTestId('home-tag-site')).toBeTruthy();
  });

  it('filtra por pasta e por tag consultando o servidor', async () => {
    render(<HomeScreen />);
    await screen.findAllByTestId('file-card');
    fireEvent.click(screen.getByTestId('home-folder-Pessoal'));
    await waitFor(() => expect(screen.getAllByTestId('file-card')).toHaveLength(1));
    expect(screen.getByTestId('file-card').getAttribute('data-path')).toBe('/p/gama.mockup.json');
    expect(urls.some((u) => u.includes('folder=Pessoal') && u.includes('recursive=1'))).toBe(true);
    fireEvent.click(screen.getByTestId('home-tag-site'));
    await waitFor(() =>
      expect(screen.getByTestId('file-card').getAttribute('data-path')).toBe('/p/alfa.mockup.json'),
    );
    expect(urls.some((u) => u.includes('tag=site'))).toBe(true);
  });

  it('busca envia query e usa miniatura lazy', async () => {
    render(<HomeScreen />);
    await screen.findAllByTestId('file-card');
    const img = screen.getAllByRole('img')[0]!;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('src')).toContain('/api/files/thumbnail?path=');
    fireEvent.change(screen.getByTestId('home-search'), { target: { value: 'acme' } });
    await waitFor(() => expect(urls.some((u) => u.includes('query=acme'))).toBe(true));
  });

  it('erro na miniatura cai no cartão neutro; favorito chama /meta', async () => {
    render(<HomeScreen />);
    const cards = await screen.findAllByTestId('file-card');
    fireEvent.error(cards[0]!.querySelector('img')!);
    expect(await screen.findByTestId('file-thumb-fallback')).toBeTruthy();
    fireEvent.click(cards[1]!.querySelector('[data-testid="file-favorite"]')!);
    await waitFor(() =>
      expect(
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
          (c) => c[0] === '/api/files/meta',
        ),
      ).toBe(true),
    );
  });
});
