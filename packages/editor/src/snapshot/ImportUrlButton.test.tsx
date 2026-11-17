// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { ImportUrlDialog, NO_RENDER_MESSAGE, validateImportUrl } from './ImportUrlButton';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  useDoc.setState({ doc: makeDoc().doc, activeDocId: 'doc-1' });
  useUi.setState({ selection: [], toast: null, focusRequest: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useDoc.setState({ doc: null, activeDocId: null });
});

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Importar' }));

describe('validateImportUrl', () => {
  it('aceita só http(s)', () => {
    expect(validateImportUrl('')).toBeTruthy();
    expect(validateImportUrl('ftp://a.com')).toBeTruthy();
    expect(validateImportUrl('not a url')).toBeTruthy();
    expect(validateImportUrl('https://a.com')).toBeNull();
    expect(validateImportUrl(' http://localhost:3000 ')).toBeNull();
  });
});

describe('ImportUrlDialog', () => {
  it('URL inválida mostra erro e não chama o daemon', async () => {
    render(<ImportUrlDialog onClose={() => undefined} />);
    type('URL', 'ftp://x');
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('http');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('503 mostra a mensagem do motor de render', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'sem render' }),
    });
    render(<ImportUrlDialog onClose={() => undefined} />);
    type('URL', 'https://exemplo.com');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(NO_RENDER_MESSAGE);
  });

  it('outros erros mostram a mensagem do daemon', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'timeout na página' }),
    });
    render(<ImportUrlDialog onClose={() => undefined} />);
    type('URL', 'https://exemplo.com');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('timeout na página');
  });

  it('sucesso: envia o corpo certo, desabilita durante o envio, seleciona e fecha', async () => {
    const frameId = useDoc.getState().doc!.pages[0]!.frames[0]!.id;
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const onClose = vi.fn();
    render(<ImportUrlDialog onClose={onClose} />);
    type('URL', 'https://exemplo.com');
    type(/Seletor CSS/, '.hero');
    type('Largura do viewport', '1280');
    fireEvent.click(screen.getByLabelText('Anexar imagem de referência'));
    submit();
    const busy = await screen.findByRole('button', { name: 'Importando…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/import/url');
    expect(JSON.parse(init.body as string)).toMatchObject({
      url: 'https://exemplo.com',
      selector: '.hero',
      viewport: { width: 1280 },
      reference: false,
      docId: 'doc-1',
    });
    resolve({ ok: true, status: 200, json: async () => ({ frameId, nodes: 7, warnings: [] }) });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useUi.getState().selection).toEqual([frameId]);
    expect(useUi.getState().focusRequest?.nodeIds).toEqual([frameId]);
    expect(useUi.getState().toast?.text).toBe('Seção importada (7 nós)');
  });
});
