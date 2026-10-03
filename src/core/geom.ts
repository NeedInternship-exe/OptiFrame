// Polygon helpers. A contour is a closed polygon given as a list of [x, y]
// points in millimetres (last point is NOT repeated). Image convention:
// x to the right, y downwards.

export type Vec2 = [number, number];
export type Poly = Vec2[];

export interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Shoelace area: positive when the polygon turns clockwise on screen (y down). */
export function signedArea(p: Poly): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export const area = (p: Poly) => Math.abs(signedArea(p));

/** Returns the polygon with a positive signed area (clockwise on screen). */
export function orient(p: Poly): Poly {
  return signedArea(p) < 0 ? p.slice().reverse() : p;
}

export function perimeter(p: Poly): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

export function centroid(p: Poly): Vec2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % n];
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-12) return [p[0][0], p[0][1]];
  return [cx / (3 * a), cy / (3 * a)];
}

export function bbox(p: Poly): Box {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of p) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

export function rotate(p: Poly, deg: number, c: Vec2 = [0, 0]): Poly {
  const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  return p.map(([x, y]) => {
    const dx = x - c[0], dy = y - c[1];
    return [c[0] + dx * cs - dy * sn, c[1] + dx * sn + dy * cs];
  });
}

export const translate = (p: Poly, dx: number, dy: number): Poly => p.map(([x, y]) => [x + dx, y + dy]);
export const mirrorX = (p: Poly): Poly => p.map(([x, y]) => [-x, y] as Vec2).reverse();

/** Uniform resampling by arc length (n points). */
export function resample(p: Poly, n: number): Poly {
  const m = p.length;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = p[i], b = p[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const L = cum[m];
  const out: Poly = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = (k * L) / n;
    while (j < m - 1 && cum[j + 1] < t) j++;
    const a = p[j], b = p[(j + 1) % m];
    const seg = cum[j + 1] - cum[j] || 1;
    const u = (t - cum[j]) / seg;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

/** Low-pass the closed curve by keeping the first `k` Fourier harmonics. */
export function fourierSmooth(p: Poly, k: number): Poly {
  const n = p.length;
  if (2 * k + 1 >= n) return p.slice();
  const re = new Float64Array(2 * k + 1), im = new Float64Array(2 * k + 1);
  const freqs: number[] = [];
  for (let f = -k; f <= k; f++) freqs.push(f);
  freqs.forEach((f, idx) => {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * f * t) / n;
      const c = Math.cos(ang), s = Math.sin(ang);
      // z = x + i y
      sr += p[t][0] * c - p[t][1] * s;
      si += p[t][0] * s + p[t][1] * c;
    }
    re[idx] = sr / n;
    im[idx] = si / n;
  });
  const out: Poly = [];
  for (let t = 0; t < n; t++) {
    let x = 0, y = 0;
    freqs.forEach((f, idx) => {
      const ang = (2 * Math.PI * f * t) / n;
      const c = Math.cos(ang), s = Math.sin(ang);
      x += re[idx] * c - im[idx] * s;
      y += re[idx] * s + im[idx] * c;
    });
    out.push([x, y]);
  }
  return out;
}

/** Circular moving-median of a scalar series (robust smoothing). */
export function circularMedian(v: ArrayLike<number>, half: number): Float64Array {
  const n = v.length, out = new Float64Array(n), win: number[] = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let k = -half; k <= half; k++) win.push(v[(i + k + n) % n]);
    win.sort((a, b) => a - b);
    out[i] = win[half];
  }
  return out;
}

export function circularGauss(v: ArrayLike<number>, sigma: number): Float64Array {
  const n = v.length, out = new Float64Array(n);
  const r = Math.ceil(3 * sigma);
  const w: number[] = [];
  let ws = 0;
  for (let k = -r; k <= r; k++) {
    const g = Math.exp((-0.5 * k * k) / (sigma * sigma));
    w.push(g);
    ws += g;
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += v[(i + k + n) % n] * w[k + r];
    out[i] = s / ws;
  }
  return out;
}

/** Outward unit normals of an oriented (positive area) polygon. */
export function normals(p: Poly): Poly {
  const n = p.length;
  const sgn = signedArea(p) >= 0 ? 1 : -1;
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    // positive shoelace area => outward normal is (dy, -dx)
    out.push([(dy / l) * sgn, (-dx / l) * sgn]);
  }
  return out;
}

/** Offset along normals (valid for small offsets on smooth curves). */
export function offsetNormal(p: Poly, d: number): Poly {
  const nr = normals(p);
  return p.map(([x, y], i) => [x + nr[i][0] * d, y + nr[i][1] * d]);
}

export function pointSegDist(px: number, py: number, a: Vec2, b: Vec2): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - a[0]) * vx + (py - a[1]) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

export function distToPoly(pt: Vec2, poly: Poly): number {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = pointSegDist(pt[0], pt[1], poly[i], poly[(i + 1) % n]);
    if (d < best) best = d;
  }
  return best;
}

export function pointInPoly(pt: Vec2, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function convexHull(points: Poly): Poly {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Poly = [], upper: Poly = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Radius of the polygon in direction theta from centre c (ray casting). */
export function radialProfile(p: Poly, c: Vec2, n: number): Float64Array {
  const r = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n, dx = Math.cos(t), dy = Math.sin(t);
    let best = 0;
    for (let i = 0, m = p.length; i < m; i++) {
      const a = p[i], b = p[(i + 1) % m];
      // ray c + s*d intersects segment a + u*(b-a)
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const ax = a[0] - c[0], ay = a[1] - c[1];
      const s = (ax * ey - ay * ex) / den;
      const u = (ax * dy - ay * dx) / den;
      if (s > 0 && u >= 0 && u <= 1 && s > best) best = s;
    }
    r[k] = best;
  }
  return r;
}
