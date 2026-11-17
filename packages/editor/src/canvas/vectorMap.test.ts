import { describe, expect, it } from 'vitest';
import { makeViewMap, parseAspect } from './vectorMap';

describe('vectorMap', () => {
  it('uniform scale and centering (meet)', () => {
    const m = makeViewMap({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 50, w: 200, h: 100 });
    expect(m.sx).toBe(10);
    expect(m.toScreen({ x: 0, y: 0 })).toEqual({ x: 150, y: 50 });
    const back = m.toView(m.toScreen({ x: 3, y: 7 }));
    expect(back.x).toBeCloseTo(3);
    expect(back.y).toBeCloseTo(7);
  });

  it('preserveAspectRatio none stretches per axis', () => {
    const m = makeViewMap(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, w: 200, h: 100 },
      'none',
    );
    expect(m.sx).toBe(20);
    expect(m.sy).toBe(10);
    expect(parseAspect('xMinYMax slice')).toEqual({ none: false, ax: 0, ay: 1, slice: true });
  });
});
