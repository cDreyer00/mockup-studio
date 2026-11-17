import { describe, expect, it } from 'vitest';
import {
  addTrack,
  changeUnit,
  draftToCss,
  draftsFromStyle,
  draftsToStyle,
  gapDelta,
  normalizeTrackValue,
  placeItemsDelta,
  readGaps,
  readPlaceItems,
  removeTrack,
  updateTrack,
} from './gridTracks';

describe('trilhas', () => {
  it('lê repeat() como trilhas individuais e recompacta ao gravar', () => {
    const drafts = draftsFromStyle('repeat(3, minmax(0, 1fr))');
    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toEqual({ unit: 'minmax', value: '', min: '0', max: '1fr' });
    expect(draftsToStyle(drafts)).toBe('repeat(3, minmax(0, 1fr))');
  });
  it('adiciona, edita e remove trilhas', () => {
    let d = draftsFromStyle('200px 1fr');
    expect(d.map((t) => t.unit)).toEqual(['px', 'fr']);
    d = addTrack(d);
    expect(draftsToStyle(d)).toBe('200px repeat(2, 1fr)');
    d = updateTrack(d, 0, { value: '240' });
    expect(draftsToStyle(d)).toBe('240px repeat(2, 1fr)');
    d = removeTrack(removeTrack(d, 2), 1);
    expect(draftsToStyle(d)).toBe('240px');
    expect(draftsToStyle(removeTrack(d, 0))).toBeUndefined();
  });
  it('converte rascunho em CSS por unidade', () => {
    expect(draftToCss({ unit: 'fr', value: '2', min: '', max: '' })).toBe('2fr');
    expect(draftToCss({ unit: 'fr', value: 'abc', min: '', max: '' })).toBe('1fr');
    expect(draftToCss({ unit: 'px', value: '12.5', min: '', max: '' })).toBe('12.5px');
    expect(draftToCss({ unit: '%', value: '30', min: '', max: '' })).toBe('30%');
    expect(draftToCss({ unit: 'auto', value: '', min: '', max: '' })).toBe('auto');
    expect(draftToCss({ unit: 'minmax', value: '', min: '120', max: '1fr' })).toBe(
      'minmax(120px, 1fr)',
    );
    expect(draftToCss({ unit: 'css', value: 'min-content', min: '', max: '' })).toBe('min-content');
  });
  it('normaliza números puros como px', () => {
    expect(normalizeTrackValue('120')).toBe('120px');
    expect(normalizeTrackValue('0')).toBe('0');
    expect(normalizeTrackValue('1fr')).toBe('1fr');
    expect(normalizeTrackValue('')).toBe('auto');
  });
  it('troca de unidade preservando o valor', () => {
    const fr = { unit: 'fr' as const, value: '2', min: '', max: '' };
    expect(changeUnit(fr, 'px')).toMatchObject({ unit: 'px', value: '2' });
    expect(changeUnit(fr, 'minmax')).toMatchObject({ unit: 'minmax', min: '0', max: '2fr' });
    expect(changeUnit(fr, 'auto')).toMatchObject({ unit: 'auto' });
    expect(draftsToStyle([changeUnit(fr, 'auto')])).toBe('auto');
  });
  it('trilhas especiais viram texto CSS', () => {
    const [d] = draftsFromStyle('min-content');
    expect(d).toEqual({ unit: 'css', value: 'min-content', min: '', max: '' });
    expect(draftsToStyle(draftsFromStyle('none'))).toBeUndefined();
  });
});

describe('gap', () => {
  it('lê o shorthand e as formas longas', () => {
    expect(readGaps({ gap: '8px' })).toEqual({ col: '8px', row: '8px', both: '8px' });
    expect(readGaps({ gap: '8px 16px' })).toEqual({ col: '16px', row: '8px', both: null });
    expect(readGaps({ 'column-gap': '4px' })).toEqual({ col: '4px', row: undefined, both: null });
    expect(readGaps({}).both).toBeUndefined();
  });
  it('gap único limpa as formas longas', () => {
    expect(gapDelta({ 'column-gap': '4px', 'row-gap': '6px' }, 'both', '12px')).toEqual({
      set: { gap: '12px' },
      unset: ['column-gap', 'row-gap'],
    });
  });
  it('um eixo expande o shorthand', () => {
    expect(gapDelta({ gap: '8px' }, 'col', '20px')).toEqual({
      set: { 'column-gap': '20px', 'row-gap': '8px' },
      unset: ['gap'],
    });
  });
  it('eixos iguais voltam a gap; vazio remove', () => {
    expect(gapDelta({ 'column-gap': '8px', 'row-gap': '4px' }, 'row', '8px')).toEqual({
      set: { gap: '8px' },
      unset: ['column-gap', 'row-gap'],
    });
    expect(gapDelta({ gap: '8px' }, 'both', '')).toEqual({ set: {}, unset: ['gap'] });
  });
});

describe('place-items', () => {
  it('lê o shorthand', () => {
    expect(readPlaceItems({ 'place-items': 'center' })).toEqual({
      align: 'center',
      justify: 'center',
    });
    expect(readPlaceItems({ 'place-items': 'start end' })).toEqual({
      align: 'start',
      justify: 'end',
    });
  });
  it('escreve as formas longas e expande o shorthand', () => {
    expect(placeItemsDelta({}, 'justify', 'center')).toEqual({
      set: { 'justify-items': 'center' },
      unset: [],
    });
    expect(placeItemsDelta({ 'justify-items': 'center' }, 'justify', '')).toEqual({
      set: {},
      unset: ['justify-items'],
    });
    expect(placeItemsDelta({ 'place-items': 'center' }, 'align', 'start')).toEqual({
      set: { 'align-items': 'start', 'justify-items': 'center' },
      unset: ['place-items'],
    });
  });
});
