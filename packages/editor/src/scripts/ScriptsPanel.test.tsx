// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { ScriptOutput, formatResult } from './ScriptOutput';
import { ScriptsPanel } from './ScriptsPanel';
import { DEFAULT_SCRIPT, useScripts } from './scriptsStore';
import { scriptCompletions } from './cm';

const DOC = 'doc_1';

describe('ScriptsPanel', () => {
  beforeEach(() => {
    useScripts.setState({ drafts: {} });
    useDoc.setState({ activeDocId: DOC, status: 'online' });
    useUi.setState({ selection: ['n1', 'in_x/n2'] });
    vi.spyOn(daemon, 'scriptList').mockResolvedValue({
      dir: '/tmp/scripts',
      scripts: [{ name: 'a.js', size: 10, updatedAt: '2026-01-01T00:00:00Z' }],
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useDoc.setState({ activeDocId: null });
    useUi.setState({ selection: [] });
  });

  it('mostra o editor (fallback até o CodeMirror carregar) e o botão Executar', async () => {
    render(<ScriptsPanel />);
    await act(async () => undefined);
    expect(screen.getByTestId('script-editor')).toBeTruthy();
    expect(screen.getByTestId('script-run')).toBeTruthy();
    expect(screen.getByTestId('script-output').getAttribute('data-state')).toBe('empty');
  });

  it('Executar envia o código e a seleção real e mostra a saída', async () => {
    const run = vi.spyOn(daemon, 'scriptRun').mockResolvedValue({
      ok: true,
      logs: ['olá'],
      result: { n: 2 },
      images: [{ nodeId: 'n1', mime: 'image/png', data: 'AAAA', width: 10, height: 5 }],
      opsCount: 3,
      durationMs: 12.4,
    });
    render(<ScriptsPanel />);
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByTestId('script-run'));
    });
    expect(run).toHaveBeenCalledWith(DEFAULT_SCRIPT, { selection: ['n1'], docId: DOC });
    const out = screen.getByTestId('script-output');
    expect(out.getAttribute('data-state')).toBe('ok');
    expect(out.textContent).toContain('olá');
    expect(screen.getByTestId('script-result').textContent).toContain('"n": 2');
    expect(screen.getByTestId('script-image').getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(screen.getByTestId('script-meta').textContent).toContain('3 ops • 12 ms');
  });

  it('erro de execução aparece em vermelho (alert)', async () => {
    vi.spyOn(daemon, 'scriptRun').mockRejectedValue(new Error('Sem conexão com o daemon'));
    render(<ScriptsPanel />);
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByTestId('script-run'));
    });
    expect(screen.getByTestId('script-error').textContent).toContain('Sem conexão');
  });

  it('biblioteca: lista, abre e avisa quando o documento não tem caminho', async () => {
    const read = vi
      .spyOn(daemon, 'scriptRead')
      .mockResolvedValue({ name: 'a.js', code: 'return 7' });
    render(<ScriptsPanel />);
    await act(async () => undefined);
    fireEvent.click(screen.getByTestId('script-library-toggle'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('script-open-a.js'));
    });
    expect(read).toHaveBeenCalledWith('a.js', DOC);
    expect(useScripts.getState().drafts[DOC]).toMatchObject({ code: 'return 7', name: 'a.js' });

    cleanup();
    vi.spyOn(daemon, 'scriptList').mockResolvedValue({ dir: null, scripts: [] });
    render(<ScriptsPanel />);
    await act(async () => undefined);
    fireEvent.click(screen.getByTestId('script-library-toggle'));
    expect(screen.getByTestId('script-library-nopath')).toBeTruthy();
  });

  it('Gerar com IA preenche o editor; falha mostra o erro', async () => {
    const gen = vi
      .spyOn(daemon, 'scriptGenerate')
      .mockResolvedValueOnce({ code: 'return 42' })
      .mockRejectedValueOnce(new Error('Backend indisponível'));
    render(<ScriptsPanel />);
    await act(async () => undefined);
    fireEvent.change(screen.getByTestId('script-ai-prompt'), { target: { value: 'liste frames' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('script-ai-generate'));
    });
    expect(gen).toHaveBeenCalledWith('liste frames', DOC);
    expect(useScripts.getState().drafts[DOC]!.code).toBe('return 42');
    await act(async () => {
      fireEvent.click(screen.getByTestId('script-ai-generate'));
    });
    expect(screen.getByTestId('script-ai-error').textContent).toBe('Backend indisponível');
  });

  it('exemplo carrega o código no rascunho', async () => {
    render(<ScriptsPanel />);
    await act(async () => undefined);
    fireEvent.change(screen.getByTestId('script-examples'), { target: { value: 'rename-texts' } });
    expect(useScripts.getState().drafts[DOC]!.code).toContain("doc.select('text')");
  });
});

describe('ScriptOutput / completions', () => {
  afterEach(cleanup);

  it('formatResult serializa em JSON e tolera valores não serializáveis', () => {
    expect(formatResult(undefined)).toBe('');
    expect(formatResult([1, 2])).toBe('[\n  1,\n  2\n]');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(formatResult(cyc)).toBe('[object Object]');
  });

  it('erro de script: estado "error" e resumo de ops', () => {
    render(
      <ScriptOutput
        running={false}
        output={{
          ok: false,
          logs: [],
          error: 'ReferenceError: x',
          images: [],
          opsCount: 0,
          durationMs: 1,
        }}
      />,
    );
    expect(screen.getByTestId('script-output').getAttribute('data-state')).toBe('error');
    expect(screen.getByTestId('script-meta').textContent).toBe('0 ops • 1 ms');
  });

  it('autocomplete oferece a API de doc. e dos handles', () => {
    const ctx = (text: string) => ({
      explicit: false,
      matchBefore: (re: RegExp) => {
        const m = re.exec(text);
        return m ? { from: m.index, to: text.length, text: m[0] } : null;
      },
    });
    const doc = scriptCompletions(ctx('doc.se') as never);
    expect(doc?.options.map((o) => o.label)).toContain('selectOne');
    expect(doc?.from).toBe(4);
    const h = scriptCompletions(ctx('btn.set') as never);
    expect(h?.options.map((o) => o.label)).toContain('setStyle');
  });
});
