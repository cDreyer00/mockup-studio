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
  describeSource,
  editedSource,
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
  const title = createNodeFromTag('p', { text: '{{name}} - {{role}}' });
  const holder = createNodeFromTag('div', { children: [title] });
  return createRepeaterFrom(holder, [
    { name: 'Ana', age: 30 },
    { name: 'Bia', age: 25 },
  ]);
}

describe('dataTable', () => {
  const data = [{ name: 'Ana', age: 30 }, { name: 'Bia' }];

  it('setCell keeps the previous type and returns a new list', () => {
    const next = setCell(data, 0, 'age', '31');
    expect(next[0]).toEqual({ name: 'Ana', age: 31 });
    expect(data[0]).toEqual({ name: 'Ana', age: 30 });
    expect(setCell(data, 1, 'role', 'Dev')[1]).toEqual({ name: 'Bia', role: 'Dev' });
    expect(parseCell('abc', 5)).toBe('abc');
    expect(parseCell('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('rows and columns', () => {
    expect(addRow(data, ['name', 'age'])).toHaveLength(3);
    expect(addRow(data, ['name', 'age'])[2]).toEqual({ name: '', age: '' });
    expect(removeRow(data, 0)).toEqual([{ name: 'Bia' }]);
    expect(addColumn(data, 'role')).toEqual([
      { name: 'Ana', age: 30, role: '' },
      { name: 'Bia', role: '' },
    ]);
    expect(removeColumn(data, 'age')[0]).toEqual({ name: 'Ana' });
  });

  it('columns = data + template fields; mapping only for what is missing', () => {
    const rep = makeRepeater();
    expect(tableColumns(rep)).toEqual(['name', 'age', 'role']);
    expect(unmappedFields(rep)).toEqual(['role']);
    expect(withMapping(undefined, 'role', 'age')).toEqual({
      kind: 'inline',
      mapping: { role: 'age' },
    });
    expect(withMapping({ kind: 'inline', mapping: { role: 'age' } }, 'role', '')).toEqual({
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

  it('shows the table and the counter', () => {
    render(<PropertiesPanel />);
    expect(screen.getByTestId('data-section')).toBeTruthy();
    expect(screen.getByTestId('data-count').textContent).toBe('2 items');
    expect((screen.getByTestId('data-cell-0-name') as HTMLInputElement).value).toBe('Ana');
    expect((screen.getByTestId('data-cell-1-age') as HTMLInputElement).value).toBe('25');
  });

  it('editing a cell sends setData with the new list (one op)', () => {
    render(<PropertiesPanel />);
    const cell = screen.getByTestId('data-cell-0-name');
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
              { name: 'Ana Maria', age: 30 },
              { name: 'Bia', age: 25 },
            ],
          },
        ],
      },
    ]);
  });

  it('editing data from a file switches the source to inline (Refresh does not discard the edit)', () => {
    rep.dataSource = {
      kind: 'json',
      path: 'C:/data/p.json',
      select: 'items',
      mapping: { role: 'age' },
      fetchedAt: '2026-11-16T10:00:00.000Z',
    };
    render(<PropertiesPanel />);
    expect(screen.getByTestId('data-refresh').hasAttribute('disabled')).toBe(false);
    const cell = screen.getByTestId('data-cell-1-name');
    fireEvent.change(cell, { target: { value: 'Beatriz' } });
    fireEvent.blur(cell);
    expect(daemon.applySafe).toHaveBeenCalledTimes(1);
    expect(daemon.applySafe).toHaveBeenCalledWith([
      {
        type: 'setData',
        changes: [
          {
            nodeId: rep.id,
            data: [
              { name: 'Ana', age: 30 },
              { name: 'Beatriz', age: 25 },
            ],
            source: {
              kind: 'inline',
              path: 'C:/data/p.json',
              mapping: { role: 'age' },
              fetchedAt: '2026-11-16T10:00:00.000Z',
            },
          },
        ],
      },
    ]);
    expect(editedSource({ kind: 'inline' })).toBeUndefined();
    expect(describeSource({ kind: 'inline', url: 'https://x/a.json' })).toContain('Edited data');
  });

  it("adding a row includes all columns (including the template's)", () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('data-add-row'));
    const call = vi.mocked(daemon.applySafe).mock.calls[0]![0] as {
      changes: { data: unknown[] }[];
    }[];
    expect(call[0]!.changes[0]!.data).toHaveLength(3);
    expect(call[0]!.changes[0]!.data[2]).toEqual({ name: '', age: '', role: '' });
  });

  it('remove row', () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('data-remove-row-0'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setData', changes: [{ nodeId: rep.id, data: [{ name: 'Bia', age: 25 }] }] },
    ]);
  });

  it('mapping a template field writes dataSource.mapping', () => {
    render(<PropertiesPanel />);
    const select = document.querySelector<HTMLSelectElement>('[data-testid=data-mapping] select')!;
    fireEvent.change(select, { target: { value: 'age' } });
    expect(daemon.applySafe).toHaveBeenCalledWith([
      {
        type: 'setData',
        changes: [{ nodeId: rep.id, source: { kind: 'inline', mapping: { role: 'age' } } }],
      },
    ]);
  });

  it('Bind… pastes JSON and calls /bind', async () => {
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

  it('Refresh is disabled for inline data', () => {
    render(<PropertiesPanel />);
    expect((screen.getByTestId('data-refresh') as HTMLButtonElement).disabled).toBe(true);
  });

  it('container with children offers Convert to repeater', () => {
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
