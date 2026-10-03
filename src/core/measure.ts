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

/** Height of the boxing rectangle for a rotation of `deg`. */
function boxHeight(p: Poly, deg: number): number {
  const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a);
  let mn = Infinity, mx = -Infinity;
  for (const [x, y] of p) {
    const yr = x * s + y * c;
    if (yr < mn) mn = yr;
    if (yr > mx) mx = yr;
  }
  return mx - mn;
}

/**
 * Orientation that best matches how the lens is held for a caliper reading:
 * the rotation (within +/- range) that minimises the boxing height B. On the
 * mat the lens is placed roughly level, so the search range stays small.
 */
export function autoAngle(p: Poly, range = 15): number {
  let best = 0, bestH = Infinity;
  for (let d = -range; d <= range + 1e-9; d += 0.5) {
    const h = boxHeight(p, d);
    if (h < bestH) [bestH, best] = [h, d];
  }
  for (let d = best - 0.5; d <= best + 0.5 + 1e-9; d += 0.05) {
    const h = boxHeight(p, d);
    if (h < bestH) [bestH, best] = [h, d];
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
