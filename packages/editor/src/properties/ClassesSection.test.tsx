// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, Op } from '@mockup/core';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { ClassesSection } from './ClassesSection';
import { PropertiesPanel } from './PropertiesPanel';
import type { NodeCtx } from './shared';

const WAIT = { timeout: 15_000 };

const ctxOf = (node: Node, isRoot = false): NodeCtx => ({
  node,
  parent: null,
  isRoot,
  locked: false,
});

let apply: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  apply = vi.spyOn(daemon, 'applySafe').mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUi.setState({ selection: [], showAsTailwind: false });
  useDoc.setState({ doc: null });
});

const lastOps = (): Op[] => apply.mock.calls.at(-1)![0] as Op[];

describe('ClassesSection', () => {
  it('mostra "Carregando Tailwind…" e depois o campo com as classes do nó', async () => {
    const { doc, a } = makeDoc();
    a.classes = 'p-4 rounded-md';
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    expect(screen.getByTestId('classes-loading').textContent).toContain('Carregando Tailwind');
    const field = (await screen.findByTestId('prop-classes', {}, WAIT)) as HTMLTextAreaElement;
    expect(field.value).toBe('p-4 rounded-md');
  });

  it('editar e confirmar (blur) aplica setClasses + updateStyles numa única chamada', async () => {
    const { doc, a } = makeDoc();
    a.classes = 'p-4';
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    const field = await screen.findByTestId('prop-classes', {}, WAIT);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'p-8 rounded-md' } });
    fireEvent.blur(field);
    expect(apply).toHaveBeenCalledTimes(1);
    const ops = lastOps();
    const classes = ops.find((o) => o.type === 'setClasses');
    expect(classes).toEqual({
      type: 'setClasses',
      changes: [{ nodeId: a.id, classes: 'p-8 rounded-md' }],
    });
    const styles = ops.find((o) => o.type === 'updateStyles');
    expect(styles).toMatchObject({
      changes: [{ nodeId: a.id, set: { padding: '2rem' } }],
    });
  });

  it('nó sem classes: campo pré-preenchido com o estilo atual e editar não apaga o estilo', async () => {
    const { doc, abs } = makeDoc();
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(abs)]} />);
    const field = (await screen.findByTestId('prop-classes', {}, WAIT)) as HTMLTextAreaElement;
    expect(field.value).toContain('absolute');
    const before = field.value;
    fireEvent.focus(field);
    fireEvent.blur(field);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: `${before} p-4` } });
    fireEvent.blur(field);
    const styles = lastOps().find((o) => o.type === 'updateStyles') as
      { changes: { set?: Record<string, string>; unset?: string[] }[] } | undefined;
    const change = styles?.changes[0];
    expect(change?.set).toMatchObject({ padding: '1rem' });
    expect(change?.unset ?? []).not.toContain('position');
    expect(change?.unset ?? []).not.toContain('left');
    expect(change?.unset ?? []).not.toContain('top');
  });

  it('sem mudança não aplica nada; Esc descarta o rascunho', async () => {
    const { doc, a } = makeDoc();
    a.classes = 'p-4';
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    const field = (await screen.findByTestId('prop-classes', {}, WAIT)) as HTMLTextAreaElement;
    fireEvent.focus(field);
    fireEvent.blur(field);
    field.focus();
    fireEvent.change(field, { target: { value: 'p-9' } });
    // O primeiro Esc fecha as sugestões (se abertas); o seguinte descarta o rascunho.
    fireEvent.keyDown(field, { key: 'Escape' });
    if (field.value !== 'p-4') fireEvent.keyDown(field, { key: 'Escape' });
    expect(apply).not.toHaveBeenCalled();
    expect(field.value).toBe('p-4');
  });

  it('multi-seleção com classes diferentes mostra Misto e aplica a todos', async () => {
    const { doc, a, b } = makeDoc();
    a.classes = 'p-4';
    b.classes = 'p-2';
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a), ctxOf(b)]} />);
    const field = (await screen.findByTestId('prop-classes', {}, WAIT)) as HTMLTextAreaElement;
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('Misto');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'p-6' } });
    fireEvent.blur(field);
    const set = lastOps().find((o) => o.type === 'setClasses');
    expect(set).toMatchObject({
      changes: [
        { nodeId: a.id, classes: 'p-6' },
        { nodeId: b.id, classes: 'p-6' },
      ],
    });
  });

  it('autocomplete: sugere, navega por setas, mostra o CSS e aceita com Enter', async () => {
    const { doc, a } = makeDoc();
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    const field = (await screen.findByTestId('prop-classes', {}, WAIT)) as HTMLTextAreaElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'flex ro' } });
    const list = await screen.findByTestId('classes-suggestions');
    const items = within(list).getAllByTestId('classes-suggestion');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.textContent!.startsWith('ro'))).toBe(true);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const first = items[0]!.textContent!;
    expect(items[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('classes-css').textContent).toMatch(/\{|:/);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe(`flex ${first} `);
    expect(apply).not.toHaveBeenCalled();
    expect(screen.queryByTestId('classes-suggestions')).toBeNull();
  });

  it('Esc fecha as sugestões antes de descartar a edição', async () => {
    const { doc, a } = makeDoc();
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    const field = (await screen.findByTestId('prop-classes', {}, WAIT)) as HTMLTextAreaElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'ro' } });
    await screen.findByTestId('classes-suggestions');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByTestId('classes-suggestions')).toBeNull();
    expect(field.value).toBe('ro');
  });

  it('marca classes desconhecidas', async () => {
    const { doc, a } = makeDoc();
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    const field = await screen.findByTestId('prop-classes', {}, WAIT);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'p-4 nao-existe-xyz' } });
    expect((await screen.findByTestId('classes-unknown')).textContent).toContain('nao-existe-xyz');
  });

  it('"Mostrar como Tailwind" lista as classes do estilo atual (nó sem classes) e persiste no uiStore', async () => {
    const { doc, a } = makeDoc();
    a.style = { ...a.style, padding: '1rem', display: 'flex' };
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    const toggle = await screen.findByTestId('classes-as-tailwind-toggle', {}, WAIT);
    fireEvent.click(toggle);
    expect(useUi.getState().showAsTailwind).toBe(true);
    const text = screen.getByTestId('classes-as-tailwind-text').textContent!;
    expect(text).toContain('p-4');
    expect(text).toContain('flex');
    expect(screen.getByTestId('classes-copy')).toBeTruthy();
  });

  it('lista os estados do nó e remove um com setStates', async () => {
    const { doc, a } = makeDoc();
    a.states = { hover: { background: 'red' }, md: { padding: '2rem' } };
    useDoc.setState({ doc });
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    expect(screen.getByTestId('state-css-hover').textContent).toContain('background: red');
    fireEvent.click(screen.getByTestId('state-remove-hover'));
    expect(apply).toHaveBeenCalledWith([
      { type: 'setStates', changes: [{ nodeId: a.id, states: { md: { padding: '2rem' } } }] },
    ]);
    apply.mockClear();
    cleanup();
    a.states = { md: { padding: '2rem' } };
    render(<ClassesSection ctxs={[ctxOf(a)]} />);
    fireEvent.click(screen.getByTestId('state-remove-md'));
    expect(apply).toHaveBeenCalledWith([
      { type: 'setStates', changes: [{ nodeId: a.id, states: null }] },
    ]);
  });
});

describe('PropertiesPanel: CSS base', () => {
  it('sem seleção, o seletor de CSS base aplica setCssBase', async () => {
    const { doc } = makeDoc();
    useDoc.setState({ doc });
    render(<PropertiesPanel />);
    const select = screen.getByTestId('css-base') as HTMLSelectElement;
    expect(select.value).toBe('default');
    fireEvent.change(select, { target: { value: 'tailwind' } });
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith([{ type: 'setCssBase', base: 'tailwind' }]),
    );
    ui.select([]);
  });
});
