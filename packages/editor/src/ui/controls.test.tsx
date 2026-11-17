// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColorInput, TextInput } from './controls';
import { NumberInput } from './NumberInput';

afterEach(cleanup);

const input = (sel = 'input') => document.querySelector<HTMLInputElement>(sel)!;

describe('ColorInput', () => {
  it('dragging in the picker only previews; the native change commits once', () => {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    render(<ColorInput value="#000000" onCommit={onCommit} onPreview={onPreview} />);
    const swatch = input('input[type=color]');
    for (const c of ['#100000', '#200000', '#300000', '#400000']) {
      fireEvent.input(swatch, { target: { value: c } });
    }
    expect(onPreview).toHaveBeenCalledTimes(4);
    expect(onCommit).not.toHaveBeenCalled();
    swatch.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('#400000');
  });
});

describe('NumberInput', () => {
  it("Enter commits only once (the following blur doesn't repeat)", () => {
    const onCommit = vi.fn();
    render(<NumberInput value="10px" onCommit={onCommit} />);
    const el = input();
    el.focus();
    fireEvent.change(el, { target: { value: '25' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(document.activeElement).not.toBe(el);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('25px');
  });

  it('Esc discards the typed text', () => {
    const onCommit = vi.fn();
    render(<NumberInput value="10px" onCommit={onCommit} />);
    const el = input();
    el.focus();
    fireEvent.change(el, { target: { value: '999' } });
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.value).toBe('10px');
  });

  it('blur without Enter commits once; a new edit commits again', () => {
    const onCommit = vi.fn();
    render(<NumberInput value="10px" onCommit={onCommit} />);
    const el = input();
    el.focus();
    fireEvent.change(el, { target: { value: '12' } });
    fireEvent.keyDown(el, { key: 'Escape' });
    el.focus();
    fireEvent.change(el, { target: { value: '30' } });
    el.blur();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('30px');
  });
});

describe('TextInput', () => {
  it('Enter commits once and Esc discards', () => {
    const onCommit = vi.fn();
    render(<TextInput value="a" onCommit={onCommit} />);
    const el = input();
    el.focus();
    fireEvent.change(el, { target: { value: 'b' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('b');
    el.focus();
    fireEvent.change(el, { target: { value: 'c' } });
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
