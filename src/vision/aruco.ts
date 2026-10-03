// ArUco detection (OpenCV.js) + our own sub-pixel corner refinement.
//
// OpenCV finds the markers on a downscaled copy of the photo (fast). Each
// corner is then re-estimated at full resolution by fitting straight lines to
// the four outer borders of the marker (gradient peak along ~30 normals per
// border, sub-pixel, outliers rejected) and intersecting them. Using whole
// edges instead of single corner pixels makes the homography far more stable.

import type { Vec2 } from '../core/geom.ts';
import { MARKER_BY_ID } from '../core/mat.ts';
import type { MarkerDet } from './types.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any;

export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export function sampleGray(g: Gray, x: number, y: number): number {
  const W = g.width, H = g.height;
  if (!(x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1)) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0, d = g.data;
  const a = d[y0 * W + x0], b = d[y0 * W + x1], c = d[y1 * W + x0], e = d[y1 * W + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}

let detector: any = null;

function getDetector(cv: CV) {
  if (detector) return detector;
  const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
  const params = new cv.aruco_DetectorParameters();
  params.cornerRefinementMethod = cv.CORNER_REFINE_NONE;
  params.adaptiveThreshWinSizeMin = 5;
  params.adaptiveThreshWinSizeMax = 45;
  params.adaptiveThreshWinSizeStep = 8;
  params.minMarkerPerimeterRate = 0.02;
  const refine = new cv.aruco_RefineParameters(10, 3, true);
  detector = new cv.aruco_ArucoDetector(dict, params, refine);
  return detector;
}

/** Detect markers on an 8-bit grey cv.Mat; returns corners in that image's pixels. */
export function detectMarkers(cv: CV, gray: any): { id: number; corners: Vec2[] }[] {
  const det = getDetector(cv);
  const corners = new cv.MatVector(), ids = new cv.Mat(), rejected = new cv.MatVector();
  try {
    det.detectMarkers(gray, corners, ids, rejected);
    const out: { id: number; corners: Vec2[] }[] = [];
    for (let i = 0; i < corners.size(); i++) {
      const id = ids.data32S[i];
      if (!MARKER_BY_ID.has(id)) continue;
      const c = corners.get(i).data32F;
      out.push({ id, corners: [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]] });
    }
    // keep a single detection per id (the largest one)
    const best = new Map<number, { id: number; corners: Vec2[] }>();
    for (const m of out) {
      const prev = best.get(m.id);
      if (!prev || quadArea(m.corners) > quadArea(prev.corners)) best.set(m.id, m);
    }
    return [...best.values()];
  } finally {
    corners.delete();
    ids.delete();
    rejected.delete();
  }
}

function quadArea(c: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += c[i][0] * c[(i + 1) % 4][1] - c[(i + 1) % 4][0] * c[i][1];
  return Math.abs(s / 2);
}

interface Line {
  p: Vec2; // point on the line
  d: Vec2; // unit direction
}

function fitLine(pts: Vec2[]): Line | null {
  if (pts.length < 4) return null;
  let keep = pts;
  for (let iter = 0; iter < 2; iter++) {
    let mx = 0, my = 0;
    for (const [x, y] of keep) (mx += x), (my += y);
    mx /= keep.length;
    my /= keep.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of keep) {
      const dx = x - mx, dy = y - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const d: Vec2 = [Math.cos(ang), Math.sin(ang)];
    const res = keep.map(([x, y]) => Math.abs(-(x - mx) * d[1] + (y - my) * d[0]));
    if (iter === 1 || keep.length < 6) return { p: [mx, my], d };
    const sorted = res.slice().sort((a, b) => a - b);
    const mad = sorted[Math.floor(sorted.length / 2)] || 0.05;
    const next = keep.filter((_, i) => res[i] <= Math.max(0.3, 3 * mad));
    if (next.length < 4) return { p: [mx, my], d };
    keep = next;
  }
  return null;
}

function intersect(a: Line, b: Line): Vec2 | null {
  const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
  return [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
}

/**
 * Refine the 4 corners of a marker at full resolution.
 * The marker border is black inside, the paper is white outside.
 */
export function refineMarker(g: Gray, id: number, c: Vec2[]): MarkerDet {
  const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4;
  const cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
  const lines: (Line | null)[] = [];
  const spreads: number[] = [];
  for (let e = 0; e < 4; e++) {
    const a = c[e], b = c[(e + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let nrm: Vec2 = [-dir[1], dir[0]];
    const mx = (a[0] + b[0]) / 2 - cx, my = (a[1] + b[1]) / 2 - cy;
    if (nrm[0] * mx + nrm[1] * my < 0) nrm = [-nrm[0], -nrm[1]];
    const w = Math.max(2.5, (len / 6) * 0.45); // stay within half a cell
    const step = 0.25;
    const S = Math.floor((2 * w) / step) + 1;
    const K = Math.max(8, Math.min(40, Math.round(len / 3)));
    const pts: Vec2[] = [];
    const prof = new Float64Array(S);
    for (let k = 0; k < K; k++) {
      const t = 0.14 + (0.72 * k) / (K - 1);
      const px = a[0] + dir[0] * len * t, py = a[1] + dir[1] * len * t;
      let bad = false;
      for (let s = 0; s < S; s++) {
        const o = -w + s * step;
        const v = sampleGray(g, px + nrm[0] * o, py + nrm[1] * o);
        if (Number.isNaN(v)) {
          bad = true;
          break;
        }
        prof[s] = v;
      }
      if (bad) continue;
      // derivative of a lightly smoothed profile (white outside => positive)
      let best = -Infinity, bi = -1;
      const dv = new Float64Array(S);
      for (let s = 2; s < S - 2; s++) {
        dv[s] = (prof[s + 1] + prof[s + 2] - prof[s - 1] - prof[s - 2]) / 6;
        if (dv[s] > best) (best = dv[s]), (bi = s);
      }
      const lo = (prof[0] + prof[1] + prof[2]) / 3, hi = (prof[S - 1] + prof[S - 2] + prof[S - 3]) / 3;
      if (bi < 3 || bi > S - 4 || hi - lo < 25) continue;
      const y0 = dv[bi - 1], y1 = dv[bi], y2 = dv[bi + 1];
      const den = y0 - 2 * y1 + y2;
      const sub = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
      const o = -w + (bi + Math.max(-0.5, Math.min(0.5, sub))) * step;
      pts.push([px + nrm[0] * o, py + nrm[1] * o]);
      // 20-80 % rise distance (blur estimate)
      const l20 = lo + 0.2 * (hi - lo), l80 = lo + 0.8 * (hi - lo);
      let s20 = NaN, s80 = NaN;
      for (let s = 1; s < S; s++) {
        if (Number.isNaN(s20) && prof[s - 1] < l20 && prof[s] >= l20) s20 = s - 1 + (l20 - prof[s - 1]) / (prof[s] - prof[s - 1]);
        if (Number.isNaN(s80) && prof[s - 1] < l80 && prof[s] >= l80) s80 = s - 1 + (l80 - prof[s - 1]) / (prof[s] - prof[s - 1]);
      }
      if (s80 > s20) spreads.push((s80 - s20) * step);
    }
    lines.push(fitLine(pts));
  }
  spreads.sort((x, y) => x - y);
  const spread = spreads.length ? spreads[Math.floor(spreads.length / 2)] : NaN;
  const out: Vec2[] = [];
  let ok = true;
  for (let i = 0; i < 4; i++) {
    const la = lines[(i + 3) % 4], lb = lines[i];
    const p = la && lb ? intersect(la, lb) : null;
    const side = Math.hypot(c[(i + 1) % 4][0] - c[i][0], c[(i + 1) % 4][1] - c[i][1]);
    if (!p || Math.hypot(p[0] - c[i][0], p[1] - c[i][1]) > Math.max(2.5, 0.06 * side)) {
      ok = false;
      break;
    }
    out.push(p);
  }
  return { id, corners: ok ? out : c.map((p) => [p[0], p[1]] as Vec2), refined: ok, edgeSpreadPx: spread };
}
