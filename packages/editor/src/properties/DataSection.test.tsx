// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeFromTag, createRepeaterFrom } from '@mockup/core';
import type { Node } from '@mockup/core';
import { daemon } from '../client/daemon';
import { features } from '../client/features';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import {
  addColumn,
  addRow,
  parseCell,
  removeColumn,
  removeRow,
  setCell,
  tableColumns,
  unmappedFields,
  withMapping,
} from './dataTable';
import { PropertiesPanel } from './PropertiesPanel';

function makeRepeater(): Node {
  const title = createNodeFromTag('p', { text: '{{nome}} - {{cargo}}' });
  const holder = createNodeFromTag('div', { children: [title] });
  return createRepeaterFrom(holder, [
    { nome: 'Ana', idade: 30 },
    { nome: 'Bia', idade: 25 },
  ]);
}

describe('dataTable', () => {
  const data = [{ nome: 'Ana', idade: 30 }, { nome: 'Bia' }];

  it('setCell preserva o tipo anterior e devolve lista nova', () => {
    const next = setCell(data, 0, 'idade', '31');
    expect(next[0]).toEqual({ nome: 'Ana', idade: 31 });
    expect(data[0]).toEqual({ nome: 'Ana', idade: 30 });
    expect(setCell(data, 1, 'cargo', 'Dev')[1]).toEqual({ nome: 'Bia', cargo: 'Dev' });
    expect(parseCell('abc', 5)).toBe('abc');
    expect(parseCell('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('linhas e colunas', () => {
    expect(addRow(data, ['nome', 'idade'])).toHaveLength(3);
    expect(addRow(data, ['nome', 'idade'])[2]).toEqual({ nome: '', idade: '' });
    expect(removeRow(data, 0)).toEqual([{ nome: 'Bia' }]);
    expect(addColumn(data, 'cargo')).toEqual([
      { nome: 'Ana', idade: 30, cargo: '' },
      { nome: 'Bia', cargo: '' },
    ]);
    expect(removeColumn(data, 'idade')[0]).toEqual({ nome: 'Ana' });
  });

  it('colunas = dados + campos do template; mapeamento só para o que falta', () => {
    const rep = makeRepeater();
    expect(tableColumns(rep)).toEqual(['nome', 'idade', 'cargo']);
    expect(unmappedFields(rep)).toEqual(['cargo']);
    expect(withMapping(undefined, 'cargo', 'idade')).toEqual({
      kind: 'inline',
      mapping: { cargo: 'idade' },
    });
    expect(withMapping({ kind: 'inline', mapping: { cargo: 'idade' } }, 'cargo', '')).toEqual({
      kind: 'inline',
    });
  });
});

describe('DataSection', () => {
  let rep: Node;
  beforeEach(() => {
    const { doc, frame } = makeDoc();
    rep = makeRepeater();
    frame.children.push(rep);
    useDoc.setState({ doc });
    ui.select([rep.id]);
    vi.spyOn(daemon, 'applySafe').mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUi.setState({ selection: [] });
  });

  it('mostra a tabela e o contador', () => {
    render(<PropertiesPanel />);
    expect(screen.getByTestId('data-section')).toBeTruthy();
    expect(screen.getByTestId('data-count').textContent).toBe('2 itens');
    expect((screen.getByTestId('data-cell-0-nome') as HTMLInputElement).value).toBe('Ana');
    expect((screen.getByTestId('data-cell-1-idade') as HTMLInputElement).value).toBe('25');
  });

  it('editar uma célula envia setData com a lista nova (uma op)', () => {
    render(<PropertiesPanel />);
    const cell = screen.getByTestId('data-cell-0-nome');
    fireEvent.change(cell, { target: { value: 'Ana Maria' } });
    fireEvent.blur(cell);
    expect(daemon.applySafe).toHaveBeenCalledTimes(1);
    expect(daemon.applySafe).toHaveBeenCalledWith([
      {
        type: 'setData',
        changes: [
          {
            nodeId: rep.id,
            data: [
              { nome: 'Ana Maria', idade: 30 },
              { nome: 'Bia', idade: 25 },
            ],
          },
        ],
      },
    ]);
  });

  it('adicionar linha inclui todas as colunas (inclusive do template)', () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('data-add-row'));
    const call = vi.mocked(daemon.applySafe).mock.calls[0]![0] as {
      changes: { data: unknown[] }[];
    }[];
    expect(call[0]!.changes[0]!.data).toHaveLength(3);
    expect(call[0]!.changes[0]!.data[2]).toEqual({ nome: '', idade: '', cargo: '' });
  });

  it('remover linha', () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('data-remove-row-0'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setData', changes: [{ nodeId: rep.id, data: [{ nome: 'Bia', idade: 25 }] }] },
    ]);
  });

  it('mapear campo do template grava dataSource.mapping', () => {
    render(<PropertiesPanel />);
    const select = document.querySelector<HTMLSelectElement>('[data-testid=data-mapping] select')!;
    fireEvent.change(select, { target: { value: 'idade' } });
    expect(daemon.applySafe).toHaveBeenCalledWith([
      {
        type: 'setData',
        changes: [{ nodeId: rep.id, source: { kind: 'inline', mapping: { cargo: 'idade' } } }],
      },
    ]);
  });

  it('Vincular… cola JSON e chama /bind', async () => {
    const bind = vi
      .spyOn(features, 'bindData')
      .mockResolvedValue({ nodeId: rep.id, count: 1, columns: ['a'], source: { kind: 'inline' } });
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('data-bind-button'));
    expect(screen.getByTestId('data-bind-dialog')).toBeTruthy();
    fireEvent.change(screen.getByTestId('data-bind-text'), { target: { value: '[{"a":1}]' } });
    fireEvent.click(screen.getByTestId('data-bind-submit'));
    await vi.waitFor(() => expect(bind).toHaveBeenCalled());
    expect(bind).toHaveBeenCalledWith(rep.id, { text: '[{"a":1}]', format: 'json' });
  });

  it('Atualizar fica desabilitado em dados inline', () => {
    render(<PropertiesPanel />);
    expect((screen.getByTestId('data-refresh') as HTMLButtonElement).disabled).toBe(true);
  });

  it('contêiner com filhos oferece Converter em repetidor', () => {
    const { doc, c } = makeDoc();
    useDoc.setState({ doc });
    ui.select([c.id]);
    const convert = vi.spyOn(features, 'bindData').mockResolvedValue({
      nodeId: 'rp_new',
      count: 0,
      columns: [],
      source: { kind: 'inline' },
    });
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('convert-to-repeater'));
    expect(convert).toHaveBeenCalledWith(c.id, { data: [] });
  });
});
