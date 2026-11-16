import { describe, expect, it } from 'vitest';
import { makeDoc } from '../test/fixtures';
import {
  computeInsertIndex,
  distanceGuides,
  fitRect,
  isNoopReorder,
  marqueeHits,
  rectsIntersect,
  resizeRect,
  resolveClickTarget,
  resolveDoubleClick,
  resolveFlowInsert,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
} from './geometry';
import type { Rect } from './geometry';

describe('resolveClickTarget', () => {
  const { doc, frame, a, b, c, abs } = makeDoc();
  const c1 = c.children[0]!;

  it('sem seleção: filho direto do frame', () => {
    expect(resolveClickTarget(doc, c1.id, [], {})).toBe(c.id);
    expect(resolveClickTarget(doc, a.id, [], {})).toBe(a.id);
  });
  it('clique no próprio frame seleciona o frame', () => {
    expect(resolveClickTarget(doc, frame.id, [], {})).toBe(frame.id);
  });
  it('com seleção num irmão, o clique escolhe o irmão (nível da seleção)', () => {
    expect(resolveClickTarget(doc, b.id, [a.id], {})).toBe(b.id);
    expect(resolveClickTarget(doc, c1.id, [a.id], {})).toBe(c.id);
    expect(resolveClickTarget(doc, abs.id, [b.id], {})).toBe(abs.id);
  });
  it('frame selecionado: clique num descendente seleciona o filho direto', () => {
    expect(resolveClickTarget(doc, c1.id, [frame.id], {})).toBe(c.id);
  });
  it('deep seleciona o próprio alvo', () => {
    expect(resolveClickTarget(doc, c1.id, [], { deep: true })).toBe(c1.id);
  });
  it('nós travados caem no ancestral selecionável', () => {
    const locked = structuredClone(doc);
    const lc = locked.pages[0]!.frames[0]!.children[2]!;
    lc.locked = true;
    expect(resolveClickTarget(locked, lc.children[0]!.id, [], { deep: true })).toBe(
      locked.pages[0]!.frames[0]!.id,
    );
    expect(resolveClickTarget(locked, lc.children[0]!.id, [], {})).toBe(
      locked.pages[0]!.frames[0]!.id,
    );
  });
  it('frame travado: nada selecionável', () => {
    const locked = structuredClone(doc);
    locked.pages[0]!.frames[0]!.locked = true;
    expect(resolveClickTarget(locked, a.id, [], {})).toBeNull();
  });
});

describe('resolveDoubleClick', () => {
  const { doc, b, c } = makeDoc();
  const c1 = c.children[0]!;
  it('desce um nível', () => {
    expect(resolveDoubleClick(doc, c1.id, [c.id])).toEqual({ select: c1.id, edit: null });
  });
  it('texto selecionado entra em edição', () => {
    expect(resolveDoubleClick(doc, b.id, [b.id])).toEqual({ select: null, edit: b.id });
  });
  it('sem seleção na cadeia: seleciona o filho direto', () => {
    expect(resolveDoubleClick(doc, c1.id, [])).toEqual({ select: c.id, edit: null });
  });
});

describe('computeInsertIndex', () => {
  const col: Rect[] = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 0, y: 108, w: 100, h: 100 },
    { x: 0, y: 216, w: 100, h: 100 },
  ];
  it('coluna: antes/depois pelo centro', () => {
    expect(computeInsertIndex(col, { x: 50, y: 10 }, 'column')).toBe(0);
    expect(computeInsertIndex(col, { x: 50, y: 90 }, 'column')).toBe(1);
    expect(computeInsertIndex(col, { x: 50, y: 400 }, 'column')).toBe(3);
  });
  it('linha', () => {
    const row = col.map((r, i) => ({ x: i * 108, y: 0, w: 100, h: 100 }));
    expect(computeInsertIndex(row, { x: 120, y: 50 }, 'row')).toBe(1);
    expect(computeInsertIndex(row, { x: 200, y: 50 }, 'row')).toBe(2);
  });
  it('ignora os nós movidos', () => {
    expect(computeInsertIndex(col, { x: 50, y: 250 }, 'column', [1])).toBe(2);
    expect(computeInsertIndex(col, { x: 50, y: 5 }, 'column', [0])).toBe(1);
  });
  it('sem irmãos: 0', () => {
    expect(computeInsertIndex([], { x: 0, y: 0 }, 'row')).toBe(0);
  });
  it('resolveFlowInsert converte para o índice pós-remoção', () => {
    const sib = col.map((rect, index) => ({ index, rect }));
    // arrastando o item 0 para depois do item 1 (gap 2) → index 1 após remover o 0
    const r = resolveFlowInsert(sib, { x: 50, y: 290 }, 'column', [0]);
    expect(r.gap).toBe(3);
    expect(r.moveIndex).toBe(2);
    expect(r.line?.y).toBe(200 + 8 + 108);
    const same = resolveFlowInsert(sib, { x: 50, y: 5 }, 'column', [1]);
    expect(isNoopReorder([1], same.moveIndex)).toBe(false);
    const stay = resolveFlowInsert(sib, { x: 50, y: 160 }, 'column', [2]);
    expect(isNoopReorder([2], stay.moveIndex)).toBe(true);
  });
});

describe('resizeRect', () => {
  const r: Rect = { x: 10, y: 10, w: 100, h: 50 };
  it('alça se / nw', () => {
    expect(resizeRect(r, 'se', 20, 10)).toEqual({ x: 10, y: 10, w: 120, h: 60 });
    expect(resizeRect(r, 'nw', 10, 5)).toEqual({ x: 20, y: 15, w: 90, h: 45 });
  });
  it('alças de borda mexem só em um eixo', () => {
    expect(resizeRect(r, 'e', 30, 99)).toEqual({ x: 10, y: 10, w: 130, h: 50 });
    expect(resizeRect(r, 'n', 99, -10)).toEqual({ x: 10, y: 0, w: 100, h: 60 });
  });
  it('tamanho mínimo 1', () => {
    expect(resizeRect(r, 'se', -500, -500)).toMatchObject({ w: 1, h: 1 });
    expect(resizeRect(r, 'w', 500, 0)).toMatchObject({ x: 109, w: 1 });
  });
  it('fromCenter (Alt)', () => {
    expect(resizeRect(r, 'e', 10, 0, { fromCenter: true })).toEqual({ x: 0, y: 10, w: 120, h: 50 });
  });
  it('keepRatio (Shift)', () => {
    const k = resizeRect(r, 'se', 100, 0, { keepRatio: true });
    expect(k.w / k.h).toBeCloseTo(2);
    const e = resizeRect(r, 'e', 100, 0, { keepRatio: true });
    expect(e.w).toBe(200);
    expect(e.h).toBe(100);
    expect(e.y).toBe(-15);
  });
});

describe('marquee', () => {
  it('interseção', () => {
    const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });
  it('marqueeHits', () => {
    const items = [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 100 } },
      { id: 'b', rect: { x: 200, y: 0, w: 100, h: 100 } },
    ];
    expect(marqueeHits(items, { x: 50, y: 50, w: 100, h: 10 })).toEqual(['a']);
    expect(marqueeHits(items, { x: 50, y: 50, w: 200, h: 10 })).toEqual(['a', 'b']);
  });
});

describe('distanceGuides', () => {
  it('vão horizontal', () => {
    const g = distanceGuides({ x: 0, y: 0, w: 100, h: 100 }, { x: 150, y: 20, w: 50, h: 50 });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ axis: 'h', value: 50, x1: 100, x2: 150, y1: 45 });
  });
  it('vãos nos dois eixos (diagonal)', () => {
    const g = distanceGuides({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 40, w: 10, h: 10 });
    expect(g.map((x) => [x.axis, x.value]).sort()).toEqual([
      ['h', 20],
      ['v', 30],
    ]);
  });
  it('contido: 4 distâncias internas e escala', () => {
    const g = distanceGuides({ x: 0, y: 0, w: 200, h: 100 }, { x: 20, y: 10, w: 100, h: 50 }, 2);
    expect(g.map((x) => x.value)).toEqual([10, 40, 5, 20]);
  });
});

describe('viewport', () => {
  it('tela ↔ mundo são inversas', () => {
    const vp = { x: 30, y: -20, z: 2 };
    const p = { x: 123, y: 45 };
    expect(screenToWorld(vp, worldToScreen(vp, p))).toEqual(p);
  });
  it('zoom no ponteiro mantém o ponto fixo', () => {
    const vp = { x: 10, y: 20, z: 1 };
    const next = zoomAtPoint(vp, 2, 100, 100);
    expect(worldToScreen(next, screenToWorld(vp, { x: 100, y: 100 }))).toEqual({ x: 100, y: 100 });
    expect(zoomAtPoint(vp, 999, 0, 0).z).toBe(16);
    expect(zoomAtPoint(vp, 0.0001, 0, 0).z).toBe(0.02);
  });
  it('fitRect centraliza e respeita o zoom máximo', () => {
    const vp = fitRect({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 800 }, 60, 1);
    expect(vp.z).toBe(1);
    expect(vp.x).toBe(450);
    expect(vp.y).toBe(350);
    const big = fitRect({ x: 100, y: 0, w: 2000, h: 500 }, { w: 1000, h: 800 }, 60, 1);
    expect(big.z).toBeCloseTo(880 / 2000);
    expect(worldToScreen(big, { x: 1100, y: 250 })).toEqual({ x: 500, y: 400 });
  });
});
