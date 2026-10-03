// Boxing measurements (ISO 8624): A = horizontal width, B = vertical height of
// the rectangle that encloses the lens, plus perimeter and effective diameter.

import { area, bbox, perimeter, rotate, translate, type Poly, type Vec2 } from './geom.ts';

export interface Measures {
  A: number; // mm, boxing width
  B: number; // mm, boxing height
  perimeter: number; // mm
  area: number; // mm²
  ed: number; // mm, effective diameter = 2 x max distance from the boxing centre
  angle: number; // deg, rotation applied to align the lens with the boxing axes
}

/** Area of the boxing rectangle for a rotation of `deg`. */
function boxArea(p: Poly, deg: number): number {
  const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of p) {
    const xr = x * c - y * s, yr = x * s + y * c;
    if (xr < x0) x0 = xr;
    if (xr > x1) x1 = xr;
    if (yr < y0) y0 = yr;
    if (yr > y1) y1 = yr;
  }
  return (x1 - x0) * (y1 - y0);
}

/**
 * Small levelling of a lens placed slightly askew: the rotation (within
 * +/- range) giving the smallest boxing rectangle. For rectangular and oval
 * outlines this is the orientation where caliper jaws sit flat on the sides.
 * The user is asked to place the lens level, so the range stays small.
 */
export function autoAngle(p: Poly, range = 8): number {
  let best = 0, bestA = boxArea(p, 0) * 0.999; // slight preference for "as placed"
  for (let d = -range; d <= range + 1e-9; d += 0.5) {
    const a = boxArea(p, d);
    if (a < bestA) [bestA, best] = [a, d];
  }
  for (let d = best - 0.5; d <= best + 0.5 + 1e-9; d += 0.05) {
    const a = boxArea(p, d);
    if (a < bestA) [bestA, best] = [a, d];
  }
  return Math.abs(best) < 0.05 ? 0 : best;
}

/**
 * Align (optional auto-rotation), centre on the boxing centre and measure.
 * Returns the contour in "lens frame": boxing centre at the origin, y down.
 */
export function measureLens(raw: Poly, align: boolean): { contour: Poly; measures: Measures } {
  const angle = align ? autoAngle(raw) : 0;
  let p = angle ? rotate(raw, angle) : raw;
  const b = bbox(p);
  p = translate(p, -(b.minX + b.maxX) / 2, -(b.minY + b.maxY) / 2);
  let rmax = 0;
  for (const [x, y] of p) rmax = Math.max(rmax, Math.hypot(x, y));
  return {
    contour: p,
    measures: {
      A: b.maxX - b.minX,
      B: b.maxY - b.minY,
      perimeter: perimeter(p),
      area: area(p),
      ed: 2 * rmax,
      angle,
    },
  };
}

export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');

export function boxingCenter(p: Poly): Vec2 {
  const b = bbox(p);
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}
