import { describe, expect, it } from 'vitest';
import {
  CROP_MODE_PREVIEW_STYLE,
  NO_CROP,
  buildCropOp,
  cropFitWarning,
  cropOfStyle,
  cropToRect,
  dragCropHandle,
  isEmptyCrop,
  moveCrop,
  pxToPct,
} from './crop';

describe('crop: geometria', () => {
  it('cropToRect converte % em retângulo na caixa', () => {
    const r = cropToRect({ top: 10, right: 20, bottom: 30, left: 25 }, 200, 100);
    expect([r.x, r.y, r.w, r.h]).toEqual([50, 10, expect.closeTo(110, 5), expect.closeTo(60, 5)]);
    expect(cropToRect(NO_CROP, 80, 40)).toEqual({ x: 0, y: 0, w: 80, h: 40 });
  });

  it('pxToPct escala pelo tamanho da caixa e tolera caixa vazia', () => {
    expect(pxToPct(50, 10, 200, 100)).toEqual({ dx: 25, dy: 10 });
    expect(pxToPct(5, 5, 0, 0)).toEqual({ dx: 0, dy: 0 });
  });

  it('arrastar alças de borda mexe só no lado correspondente', () => {
    expect(dragCropHandle(NO_CROP, 'w', 10, 99)).toEqual({ top: 0, right: 0, bottom: 0, left: 10 });
    expect(dragCropHandle(NO_CROP, 'e', -15, 0)).toEqual({ top: 0, right: 15, bottom: 0, left: 0 });
    expect(dragCropHandle(NO_CROP, 'n', 0, 20)).toEqual({ top: 20, right: 0, bottom: 0, left: 0 });
    expect(dragCropHandle(NO_CROP, 's', 0, -5)).toEqual({ top: 0, right: 0, bottom: 5, left: 0 });
  });

  it('alças de canto mexem em dois lados', () => {
    expect(dragCropHandle(NO_CROP, 'nw', 10, 20)).toEqual({
      top: 20,
      right: 0,
      bottom: 0,
      left: 10,
    });
    expect(dragCropHandle(NO_CROP, 'se', -10, -20)).toEqual({
      top: 0,
      right: 10,
      bottom: 20,
      left: 0,
    });
  });

  it('não sai da imagem nem passa a borda oposta (mínimo 1% visível)', () => {
    expect(dragCropHandle(NO_CROP, 'w', -50, 0).left).toBe(0);
    expect(dragCropHandle({ ...NO_CROP, right: 40 }, 'w', 500, 0).left).toBe(59);
    expect(dragCropHandle({ ...NO_CROP, top: 30 }, 's', 0, -500).bottom).toBe(69);
  });

  it('moveCrop preserva o tamanho e fica dentro da imagem', () => {
    const c = { top: 10, right: 40, bottom: 30, left: 20 };
    expect(moveCrop(c, 10, 5)).toEqual({ top: 15, right: 30, bottom: 25, left: 30 });
    expect(moveCrop(c, 100, 100)).toEqual({ top: 40, right: 0, bottom: 0, left: 60 });
    expect(moveCrop(c, -100, -100)).toEqual({ top: 0, right: 60, bottom: 40, left: 0 });
  });

  it('isEmptyCrop e cropOfStyle', () => {
    expect(isEmptyCrop(NO_CROP)).toBe(true);
    expect(cropOfStyle({ 'object-view-box': 'inset(10% 0% 5% 0%)' })).toEqual({
      top: 10,
      right: 0,
      bottom: 5,
      left: 0,
    });
    expect(cropOfStyle({})).toEqual(NO_CROP);
    expect(cropOfStyle({ 'object-view-box': 'rect(0 0 1 1)' })).toBeNull();
  });
});

describe('crop: ops', () => {
  it('grava object-view-box com inset em %', () => {
    expect(buildCropOp('im_1', {}, { top: 10, right: 0, bottom: 5, left: 0 })).toEqual({
      type: 'updateStyles',
      changes: [{ nodeId: 'im_1', set: { 'object-view-box': 'inset(10% 0% 5% 0%)' } }],
    });
  });

  it('zerado faz unset; sem mudança não gera op', () => {
    expect(buildCropOp('im_1', { 'object-view-box': 'inset(10% 0% 0% 0%)' }, NO_CROP)).toEqual({
      type: 'updateStyles',
      changes: [{ nodeId: 'im_1', unset: ['object-view-box'] }],
    });
    expect(buildCropOp('im_1', {}, NO_CROP)).toBeNull();
    expect(
      buildCropOp('im_1', { 'object-view-box': 'inset(10% 0% 0% 0%)' }, { ...NO_CROP, top: 10 }),
    ).toBeNull();
  });

  it('modo de recorte mostra a imagem inteira em fill', () => {
    expect(CROP_MODE_PREVIEW_STYLE).toEqual({ 'object-fit': 'fill', 'object-view-box': 'none' });
  });

  it('avisa quando object-fit não é cover/fill', () => {
    expect(cropFitWarning({})).toBe(false);
    expect(cropFitWarning({ 'object-fit': 'cover' })).toBe(false);
    expect(cropFitWarning({ 'object-fit': 'fill' })).toBe(false);
    expect(cropFitWarning({ 'object-fit': 'contain' })).toBe(true);
  });
});
