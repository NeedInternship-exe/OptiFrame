// Sub-pixel edge refinement of a lens outline on the ORIGINAL photo.
//
// The network gives a robust outline at 3 px/mm. For each outline point we
// sample the full-resolution photo along the outward normal (through the
// homography, so no resampling loss), and snap to the nearby intensity edge
// "lens edge (dark) -> paper (bright)". Weak or ambiguous edges keep the
// network position; offsets are median-filtered and smoothed along the outline.

import { circularGauss, circularMedian, normals, type Poly } from '../core/geom.ts';
import { applyH, type Mat3 } from '../core/homography.ts';
import { sampleGray, type Gray } from './aruco.ts';

export interface RefineStats {
  validFrac: number;
  meanShift: number;
  maxShift: number;
}

export function refineContour(g: Gray, H: Mat3, poly: Poly, range = 0.9, step = 0.04, prior = 0.45): { contour: Poly; stats: RefineStats } {
  const n = poly.length;
  const nr = normals(poly);
  const S = Math.round((2 * range) / step) + 1;
  const off = new Float64Array(n).fill(NaN);
  const prof = new Float64Array(S), sm = new Float64Array(S), dv = new Float64Array(S);
  for (let i = 0; i < n; i++) {
    const [x, y] = poly[i], [nx, ny] = nr[i];
    let bad = false;
    for (let k = 0; k < S; k++) {
      const t = -range + k * step;
      const [u, v] = applyH(H, x + nx * t, y + ny * t);
      const val = sampleGray(g, u, v);
      if (Number.isNaN(val)) {
        bad = true;
        break;
      }
      prof[k] = val;
    }
    if (bad) continue;
    for (let k = 0; k < S; k++) sm[k] = (prof[Math.max(0, k - 1)] + 2 * prof[k] + prof[Math.min(S - 1, k + 1)]) / 4;
    let noise = 0;
    for (let k = 1; k < S - 1; k++) {
      dv[k] = (sm[k + 1] - sm[k - 1]) / 2;
      noise += Math.abs(dv[k]);
    }
    noise /= S - 2;
    let best = 0, bk = -1;
    for (let k = 2; k < S - 2; k++) {
      const d = dv[k];
      const a = Math.abs(d);
      if (a < Math.abs(dv[k - 1]) || a < Math.abs(dv[k + 1])) continue; // local extremum only
      const t = -range + k * step;
      const score = (d > 0 ? a : 0.5 * a) * Math.exp(-0.5 * (t / prior) ** 2);
      if (score > best) (best = score), (bk = k);
    }
    if (bk < 0) continue;
    const peak = Math.abs(dv[bk]);
    if (peak < Math.max(1.2, 2.5 * noise)) continue;
    const y0 = Math.abs(dv[bk - 1]), y1 = peak, y2 = Math.abs(dv[bk + 1]);
    const den = y0 - 2 * y1 + y2;
    const sub = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    off[i] = -range + (bk + sub) * step;
  }
  // robust filtering along the outline
  let valid = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(off[i])) valid++;
  const filled = new Float64Array(n);
  for (let i = 0; i < n; i++) filled[i] = Number.isNaN(off[i]) ? 0 : off[i];
  const med = circularMedian(filled, 7);
  const clean = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = off[i];
    clean[i] = Number.isNaN(o) || Math.abs(o - med[i]) > 0.25 ? med[i] : o;
  }
  const smooth = circularGauss(clean, 3);
  let sum = 0, mx = 0;
  const contour: Poly = poly.map(([x, y], i) => {
    const o = valid / n < 0.3 ? 0 : smooth[i];
    sum += Math.abs(o);
    mx = Math.max(mx, Math.abs(o));
    return [x + nr[i][0] * o, y + nr[i][1] * o];
  });
  return { contour, stats: { validFrac: valid / n, meanShift: sum / n, maxShift: mx } };
}
