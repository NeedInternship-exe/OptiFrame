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

interface QuadOpts {
  insideDark: boolean; // marker: dark inside / paper: bright inside
  win: (len: number) => number; // half search window along the normal (px)
  t0: number; // portion of each side that is sampled (corners excluded)
  samples: (len: number) => number;
  minContrast: number; // grey levels between both sides of the edge
  maxMove: (side: number) => number; // reject refined corners that moved too far
}

/**
 * Refine a quadrilateral at full resolution: fit a straight line to each side
 * (sub-pixel gradient peak along ~K normals, outliers rejected) and intersect
 * the lines. Also returns the median 20-80 % edge rise (blur estimate).
 */
export function refineQuad(g: Gray, c: Vec2[], o: QuadOpts): { corners: Vec2[]; refined: boolean; spread: number } {
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
    // profiles always go from the dark side to the bright side
    if (!o.insideDark) nrm = [-nrm[0], -nrm[1]];
    const w = o.win(len);
    const step = Math.max(0.25, w / 40);
    const S = Math.floor((2 * w) / step) + 1;
    const K = o.samples(len);
    const pts: Vec2[] = [];
    const prof = new Float64Array(S);
    const dv = new Float64Array(S);
    for (let k = 0; k < K; k++) {
      const t = o.t0 + ((1 - 2 * o.t0) * k) / (K - 1);
      const px = a[0] + dir[0] * len * t, py = a[1] + dir[1] * len * t;
      let bad = false;
      for (let s = 0; s < S; s++) {
        const v = sampleGray(g, px + nrm[0] * (-w + s * step), py + nrm[1] * (-w + s * step));
        if (Number.isNaN(v)) {
          bad = true;
          break;
        }
        prof[s] = v;
      }
      if (bad) continue;
      // derivative of a lightly smoothed profile (dark -> bright => positive)
      let best = -Infinity, bi = -1;
      for (let s = 2; s < S - 2; s++) {
        dv[s] = (prof[s + 1] + prof[s + 2] - prof[s - 1] - prof[s - 2]) / 6;
        if (dv[s] > best) (best = dv[s]), (bi = s);
      }
      const lo = (prof[0] + prof[1] + prof[2]) / 3, hi = (prof[S - 1] + prof[S - 2] + prof[S - 3]) / 3;
      if (bi < 3 || bi > S - 4 || hi - lo < o.minContrast) continue;
      const y0 = dv[bi - 1], y1 = dv[bi], y2 = dv[bi + 1];
      const den = y0 - 2 * y1 + y2;
      const sub = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
      const off = -w + (bi + Math.max(-0.5, Math.min(0.5, sub))) * step;
      pts.push([px + nrm[0] * off, py + nrm[1] * off]);
      // blur: full width at half maximum of the gradient peak, expressed as an
      // equivalent 20-80 % rise (x 0.713 for a Gaussian edge); unlike a
      // plateau-to-plateau rise it ignores slow shading near the edge
      let l = bi, r = bi;
      while (l > 2 && dv[l - 1] > y1 / 2) l--;
      while (r < S - 3 && dv[r + 1] > y1 / 2) r++;
      const fl = l - 1 + (y1 / 2 - dv[l - 1]) / Math.max(1e-6, dv[l] - dv[l - 1]);
      const fr = r + (dv[r] - y1 / 2) / Math.max(1e-6, dv[r] - dv[r + 1]);
      const fwhm = Math.max(0, fr - fl) * step;
      // the 5-tap derivative itself spreads a perfect edge over ~2 samples
      spreads.push(0.713 * Math.sqrt(Math.max(0, fwhm * fwhm - (2 * step) ** 2)));
    }
    lines.push(fitLine(pts));
  }
  spreads.sort((x, y) => x - y);
  const spread = spreads.length ? spreads[Math.floor(spreads.length / 2)] : NaN;
  const out: Vec2[] = [];
  for (let i = 0; i < 4; i++) {
    const la = lines[(i + 3) % 4], lb = lines[i];
    const p = la && lb ? intersect(la, lb) : null;
    const side = Math.hypot(c[(i + 1) % 4][0] - c[i][0], c[(i + 1) % 4][1] - c[i][1]);
    if (!p || Math.hypot(p[0] - c[i][0], p[1] - c[i][1]) > o.maxMove(side)) {
      return { corners: c.map((q) => [q[0], q[1]] as Vec2), refined: false, spread };
    }
    out.push(p);
  }
  return { corners: out, refined: true, spread };
}

const MARKER_OPTS: QuadOpts = {
  insideDark: true,
  win: (len) => Math.max(2.5, (len / 6) * 0.45), // stay within half a cell
  t0: 0.14,
  samples: (len) => Math.max(8, Math.min(40, Math.round(len / 3))),
  minContrast: 25,
  maxMove: (side) => Math.max(2.5, 0.06 * side),
};

/** Refine the 4 corners of a marker (black border inside, white paper outside). */
export function refineMarker(g: Gray, id: number, c: Vec2[]): MarkerDet {
  const r = refineQuad(g, c, MARKER_OPTS);
  return { id, corners: r.corners, refined: r.refined, edgeSpreadPx: r.spread };
}

// --------------------------------------------------------------------------- blank sheet
const SHEET_OPTS: QuadOpts = {
  insideDark: false,
  win: (len) => Math.max(8, 0.015 * len),
  t0: 0.08,
  samples: (len) => Math.max(20, Math.min(80, Math.round(len / 8))),
  minContrast: 15,
  maxMove: (side) => Math.max(6, 0.03 * side),
};

/** Mean brightness step across the 4 sides (inside - outside), in grey levels. */
function edgeSupport(gray: any, q: Vec2[]): number {
  const W = gray.cols, H = gray.rows, d = gray.data;
  const at = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < W && yi < H ? d[yi * W + xi] : NaN;
  };
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  let worst = Infinity;
  for (let e = 0; e < 4; e++) {
    const a = q[e], b = q[(e + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) (nx = -nx), (ny = -ny); // outward
    const steps: number[] = [];
    for (let k = 1; k < 30; k++) {
      const t = k / 30, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      const v = at(x - nx * 4, y - ny * 4) - at(x + nx * 4, y + ny * 4);
      if (Number.isFinite(v)) steps.push(v);
    }
    steps.sort((u, v) => u - v);
    // the weakest side decides: a wrong corner leaves one side off the paper edge
    worst = Math.min(worst, steps.length ? steps[Math.floor(steps.length / 2)] : 0);
  }
  return worst;
}

function quadsFromBinary(cv: CV, bin: any, minArea: number): Vec2[][] {
  const cs = new cv.MatVector(), hier = new cv.Mat();
  const out: Vec2[][] = [];
  try {
    cv.findContours(bin, cs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < cs.size(); i++) {
      const cnt = cs.get(i);
      const a = cv.contourArea(cnt);
      if (a < minArea) continue;
      const hull = new cv.Mat(), poly = new cv.Mat();
      cv.convexHull(cnt, hull, false, true);
      const peri = cv.arcLength(hull, true);
      for (const eps of [0.01, 0.02, 0.03, 0.05]) {
        cv.approxPolyDP(hull, poly, eps * peri, true);
        if (poly.rows <= 4) break;
      }
      if (poly.rows === 4) {
        const dd = poly.data32S;
        const q: Vec2[] = [0, 1, 2, 3].map((j) => [dd[2 * j], dd[2 * j + 1]]);
        const inside = q.every(([x, y]) => x > 2 && y > 2 && x < bin.cols - 3 && y < bin.rows - 3);
        if (inside && quadArea(q) > 0.85 * a) out.push(orderQuad(q));
      }
      hull.delete();
      poly.delete();
    }
  } finally {
    cs.delete();
    hier.delete();
  }
  return out;
}

/**
 * Find a bright sheet of paper (its 4 corners) on a darker background.
 * Two binarisations compete (global Otsu, and a large-window local threshold
 * that survives shadows on the paper); the quadrilateral whose 4 sides show
 * the strongest paper/table contrast wins. Corners are ordered clockwise
 * starting from the top-left one of the image.
 */
export function detectSheet(cv: CV, channels: any[]): Vec2[] | null {
  const blur = new cv.Mat(), bin = new cv.Mat();
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  try {
    let best: Vec2[] | null = null, bestScore = 0;
    for (const ch of channels) {
      cv.GaussianBlur(ch, blur, new cv.Size(5, 5), 0);
      const minArea = 0.08 * ch.rows * ch.cols;
      const cands: Vec2[][] = [];
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k);
      cands.push(...quadsFromBinary(cv, bin, minArea));
      let block = Math.round(0.45 * Math.min(ch.rows, ch.cols));
      block += block % 2 ? 0 : 1;
      cv.adaptiveThreshold(blur, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, -6);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k);
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
      cands.push(...quadsFromBinary(cv, bin, minArea));
      for (const q of cands) {
        const sup = edgeSupport(blur, q);
        if (sup < 10) continue;
        const score = sup * Math.sqrt(quadArea(q));
        if (score > bestScore) (bestScore = score), (best = q);
      }
    }
    return best;
  } finally {
    blur.delete();
    bin.delete();
    k.delete();
  }
}

/**
 * "Whiteness" image: min(R, G, B). White paper stays high even in shadow
 * (neutral grey), while a coloured table (wood, fabric) drops.
 */
export function minChannel(cv: CV, rgba: any): any {
  const ch = new cv.MatVector();
  cv.split(rgba, ch);
  const r = ch.get(0), g = ch.get(1), b = ch.get(2), a = ch.get(3);
  const out = new cv.Mat();
  cv.min(r, g, out);
  cv.min(out, b, out);
  r.delete(), g.delete(), b.delete(), a.delete(), ch.delete();
  return out;
}

/** Clockwise order (image y down) starting at the corner nearest the image top-left. */
export function orderQuad(q: Vec2[]): Vec2[] {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const byAng = q.slice().sort((p, r) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(r[1] - cy, r[0] - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (byAng[i][0] + byAng[i][1] < byAng[start][0] + byAng[start][1]) start = i;
  return [0, 1, 2, 3].map((i) => byAng[(start + i) % 4]);
}

/** Wide search on the downscaled image: recovers corners cut by a shadow on the paper. */
const SHEET_COARSE_OPTS: QuadOpts = {
  insideDark: false,
  win: (len) => Math.max(10, 0.08 * len),
  t0: 0.12,
  samples: () => 60,
  minContrast: 12,
  maxMove: (side) => 0.2 * side,
};

export function refineSheet(g: Gray, c: Vec2[], coarse = false) {
  return refineQuad(g, c, coarse ? SHEET_COARSE_OPTS : SHEET_OPTS);
}
