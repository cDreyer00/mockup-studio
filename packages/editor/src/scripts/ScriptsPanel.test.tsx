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

  it('shows the editor (fallback until CodeMirror loads) and the Run button', async () => {
    render(<ScriptsPanel />);
    await act(async () => undefined);
    expect(screen.getByTestId('script-editor')).toBeTruthy();
    expect(screen.getByTestId('script-run')).toBeTruthy();
    expect(screen.getByTestId('script-output').getAttribute('data-state')).toBe('empty');
  });

  it('Run sends the code and the real selection and shows the output', async () => {
    const run = vi.spyOn(daemon, 'scriptRun').mockResolvedValue({
      ok: true,
      logs: ['hello'],
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
    expect(out.textContent).toContain('hello');
    expect(screen.getByTestId('script-result').textContent).toContain('"n": 2');
    expect(screen.getByTestId('script-image').getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(screen.getByTestId('script-meta').textContent).toContain('3 ops • 12 ms');
  });

  it('run error shows in red (alert)', async () => {
    vi.spyOn(daemon, 'scriptRun').mockRejectedValue(new Error('No connection to the daemon'));
    render(<ScriptsPanel />);
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByTestId('script-run'));
    });
    expect(screen.getByTestId('script-error').textContent).toContain('No connection');
  });

  it('library: lists, opens and warns when the document has no path', async () => {
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

  it('Generate with AI fills the editor; failure shows the error', async () => {
    const gen = vi
      .spyOn(daemon, 'scriptGenerate')
      .mockResolvedValueOnce({ code: 'return 42' })
      .mockRejectedValueOnce(new Error('Backend unavailable'));
    render(<ScriptsPanel />);
    await act(async () => undefined);
    fireEvent.change(screen.getByTestId('script-ai-prompt'), { target: { value: 'list frames' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('script-ai-generate'));
    });
    expect(gen).toHaveBeenCalledWith('list frames', DOC);
    expect(useScripts.getState().drafts[DOC]!.code).toBe('return 42');
    await act(async () => {
      fireEvent.click(screen.getByTestId('script-ai-generate'));
    });
    expect(screen.getByTestId('script-ai-error').textContent).toBe('Backend unavailable');
  });

  it('example loads the code into the draft', async () => {
    render(<ScriptsPanel />);
    await act(async () => undefined);
    fireEvent.change(screen.getByTestId('script-examples'), { target: { value: 'rename-texts' } });
    expect(useScripts.getState().drafts[DOC]!.code).toContain("doc.select('text')");
  });
});

describe('ScriptOutput / completions', () => {
  afterEach(cleanup);

  it('formatResult serializes to JSON and tolerates non-serializable values', () => {
    expect(formatResult(undefined)).toBe('');
    expect(formatResult([1, 2])).toBe('[\n  1,\n  2\n]');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(formatResult(cyc)).toBe('[object Object]');
  });

  it('script error: "error" state and ops summary', () => {
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

  it('autocomplete offers the doc. and handle APIs', () => {
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
