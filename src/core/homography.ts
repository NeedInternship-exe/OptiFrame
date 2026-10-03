// 3x3 homographies stored row-major as 9 numbers.
// H maps mat millimetres (X, Y, 1) to image pixels (u, v, 1).

import type { Poly, Vec2 } from './geom.ts';

export type Mat3 = number[];

export function applyH(H: Mat3, x: number, y: number): Vec2 {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function mul3(A: Mat3, B: Mat3): Mat3 {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Local scale of H (image pixels per mm) around a mat point. */
export function localScale(H: Mat3, x: number, y: number): number {
  const p = applyH(H, x, y), px = applyH(H, x + 1, y), py = applyH(H, x, y + 1);
  return Math.sqrt(Math.abs((px[0] - p[0]) * (py[1] - p[1]) - (px[1] - p[1]) * (py[0] - p[0])));
}

export interface CameraPose {
  f: number; // focal length used (px)
  foot: Vec2; // projection of the camera centre on the mat (mm)
  height: number; // camera height above the mat (mm)
  tiltDeg: number; // angle between the optical axis and the mat normal
}

/**
 * Recover the camera position from the plane homography, assuming square
 * pixels, a centred principal point and a typical phone focal length
 * (26 mm full-frame equivalent) when none is provided.
 */
export function cameraPose(H: Mat3, imgW: number, imgH: number, f?: number): CameraPose {
  const fpx = f ?? (26 / 43.27) * Math.hypot(imgW, imgH);
  const cx = imgW / 2 - 0.5, cy = imgH / 2 - 0.5;
  // M = K^-1 H
  const col = (j: number) => {
    const u = H[j], v = H[3 + j], w = H[6 + j];
    return [(u - cx * w) / fpx, (v - cy * w) / fpx, w];
  };
  const m1 = col(0), m2 = col(1), m3 = col(2);
  const n1 = Math.hypot(...m1), n2 = Math.hypot(...m2);
  let lam = 2 / (n1 + n2);
  if (m3[2] * lam < 0) lam = -lam; // mat in front of the camera
  const r1 = m1.map((v) => v * lam), r2 = m2.map((v) => v * lam), t = m3.map((v) => v * lam);
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  // camera centre in mat coordinates: C = -R^T t, with R = [r1 r2 r3] as columns
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const Cw = [-dot(r1, t), -dot(r2, t), -dot(r3, t)];
  const nz = Math.abs(r3[2]) / (Math.hypot(...r3) || 1);
  return { f: fpx, foot: [Cw[0], Cw[1]], height: Math.abs(Cw[2]), tiltDeg: (Math.acos(Math.min(1, nz)) * 180) / Math.PI };
}

/**
 * Parallax correction: a point of the lens edge that sits `h` mm above the
 * paper is seen pushed away from the camera foot point. Bring it back.
 */
export function correctParallax(p: Poly, pose: CameraPose, h: number): Poly {
  if (h <= 0 || pose.height <= h * 2) return p;
  const k = (pose.height - h) / pose.height;
  const [fx, fy] = pose.foot;
  return p.map(([x, y]) => [fx + (x - fx) * k, fy + (y - fy) * k]);
}
