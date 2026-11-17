// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemon } from '../client/daemon';
import { features } from '../client/features';
import { makeImage } from '../model/factory';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import {
  clipPathDelta,
  filterDelta,
  filterPreview,
  hasActiveFilters,
  objectPositionDelta,
  positionKey,
  resetFiltersDelta,
} from './imageOps';
import { PropertiesPanel } from './PropertiesPanel';

describe('imageOps', () => {
  it('filterDelta preserva funções desconhecidas e omite neutros', () => {
    expect(filterDelta('drop-shadow(0 0 2px #000)', 'sepia', 40)).toEqual({
      set: { filter: 'sepia(40%) drop-shadow(0 0 2px #000)' },
    });
    expect(filterDelta('sepia(40%)', 'sepia', 0)).toEqual({ unset: ['filter'] });
    expect(filterDelta(undefined, 'blur', 0)).toBeNull();
  });

  it('convive com o blur da seção Efeitos (mesmo filter, sem se pisar)', () => {
    expect(filterDelta('blur(4px) contrast(120%)', 'brightness', 80)).toEqual({
      set: { filter: 'blur(4px) brightness(80%) contrast(120%)' },
    });
    expect(filterPreview('blur(4px)', 'blur', 0)).toBe('');
  });

  it('resetFiltersDelta zera o que é do painel e mantém o resto', () => {
    expect(resetFiltersDelta('blur(2px) invert(100%) drop-shadow(0 0 2px #000)')).toEqual({
      set: { filter: 'drop-shadow(0 0 2px #000)' },
    });
    expect(resetFiltersDelta('blur(2px)')).toEqual({ unset: ['filter'] });
    expect(resetFiltersDelta(undefined)).toBeNull();
    expect(hasActiveFilters('opacity(100%)')).toBe(false);
    expect(hasActiveFilters('opacity(50%)')).toBe(true);
  });

  it('clip-path e object-position', () => {
    expect(clipPathDelta('circle')).toEqual({ set: { 'clip-path': 'circle(50% at 50% 50%)' } });
    expect(clipPathDelta('none')).toEqual({ unset: ['clip-path'] });
    expect(objectPositionDelta('top-left')).toEqual({ set: { 'object-position': '0% 0%' } });
    expect(positionKey(undefined)).toBe('center');
    expect(positionKey('100% 100%')).toBe('bottom-right');
    expect(positionKey('12px 3px')).toBeNull();
  });
});

describe('ImageSection', () => {
  const image = makeImage('a.png', { w: 100, h: 80 });

  beforeEach(() => {
    const { doc, frame } = makeDoc();
    frame.children.push(image);
    useDoc.setState({ doc });
    ui.select([image.id]);
    vi.spyOn(daemon, 'applySafe').mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUi.setState({ selection: [], preview: {}, cropNodeId: null, cropDraft: null });
  });

  it('só aparece quando todos os nós são imagens', () => {
    render(<PropertiesPanel />);
    expect(screen.getByTestId('image-section')).toBeTruthy();
    cleanup();
    const { doc, a } = makeDoc();
    useDoc.setState({ doc });
    ui.select([a.id]);
    render(<PropertiesPanel />);
    expect(screen.queryByTestId('image-section')).toBeNull();
  });

  it('object-fit e máscara geram updateStyles', () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('image-fit-contain'));
    expect(daemon.applySafe).toHaveBeenLastCalledWith([
      { type: 'updateStyles', changes: [{ nodeId: image.id, set: { 'object-fit': 'contain' } }] },
    ]);
    fireEvent.click(screen.getByTestId('image-clip-circle'));
    expect(daemon.applySafe).toHaveBeenLastCalledWith([
      {
        type: 'updateStyles',
        changes: [{ nodeId: image.id, set: { 'clip-path': 'circle(50% at 50% 50%)' } }],
      },
    ]);
  });

  it('slider de filtro: prévia ao vivo e uma única op ao soltar', () => {
    render(<PropertiesPanel />);
    const range = screen.getByTestId('image-filter-brightness');
    fireEvent.change(range, { target: { value: '150' } });
    fireEvent.change(range, { target: { value: '160' } });
    expect(useUi.getState().preview[image.id]?.style).toEqual({ filter: 'brightness(160%)' });
    expect(daemon.applySafe).not.toHaveBeenCalled();
    fireEvent.pointerUp(range);
    expect(daemon.applySafe).toHaveBeenCalledTimes(1);
    expect(daemon.applySafe).toHaveBeenCalledWith([
      {
        type: 'updateStyles',
        changes: [{ nodeId: image.id, set: { filter: 'brightness(160%)' } }],
      },
    ]);
  });

  it('botão Recortar entra no modo de recorte', () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('image-crop-button'));
    expect(useUi.getState().cropNodeId).toBe(image.id);
  });

  it('Gerar chama a rota de placeholder para cada imagem', () => {
    const spy = vi
      .spyOn(features, 'placeholder')
      .mockResolvedValue({ src: 'x.svg', nodeId: image.id });
    render(<PropertiesPanel />);
    fireEvent.change(screen.getByTestId('placeholder-seed'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('placeholder-generate'));
    expect(spy).toHaveBeenCalledWith({ nodeId: image.id, kind: 'avatar', seed: 'abc' });
  });
});
