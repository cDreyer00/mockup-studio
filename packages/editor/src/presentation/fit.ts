/** Fit of a slide (at its natural size) into the stage: scaled keeping the aspect ratio, centered. */
export interface Size {
  w: number;
  h: number;
}

export interface Fit {
  scale: number;
  x: number;
  y: number;
}

export function fitSlide(size: Size, stage: Size): Fit {
  const scale = Math.min(stage.w / size.w, stage.h / size.h);
  return { scale, x: (stage.w - size.w * scale) / 2, y: (stage.h - size.h * scale) / 2 };
}
