// Several shots of the same lens -> one averaged outline + spread statistics.
import { radialProfile, type Poly } from './geom.ts';
import { measureLens, type Measures } from './measure.ts';

export interface Spread {
  n: number;
  meanA: number;
  meanB: number;
  rangeA: number; // max - min
  rangeB: number;
  stdA: number;
  stdB: number;
}

export function spread(ms: Measures[]): Spread | null {
  if (!ms.length) return null;
  const A = ms.map((m) => m.A), B = ms.map((m) => m.B);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const std = (v: number[]) => {
    const m = mean(v);
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
  };
  return {
    n: ms.length,
    meanA: mean(A),
    meanB: mean(B),
    rangeA: Math.max(...A) - Math.min(...A),
    rangeB: Math.max(...B) - Math.min(...B),
    stdA: std(A),
    stdB: std(B),
  };
}

/**
 * Average outlines given in the lens frame (aligned, boxing-centred): mean of
 * the radial profiles around the common centre, 720 directions.
 */
export function fuseContours(contours: Poly[]): Poly {
  if (contours.length === 1) return contours[0];
  const n = 720;
  const acc = new Float64Array(n);
  for (const c of contours) {
    const r = radialProfile(c, [0, 0], n);
    for (let k = 0; k < n; k++) acc[k] += r[k] / contours.length;
  }
  const out: Poly = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    out.push([acc[k] * Math.cos(t), acc[k] * Math.sin(t)]);
  }
  return measureLens(out, false).contour;
}
