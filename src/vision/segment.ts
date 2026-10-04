// Lens segmentation in the rectified zone image, and probability map -> contour.

import { area, convexHull, fourierSmooth, offsetNormal, resample, type Poly } from '../core/geom.ts';
import { PPM_MODEL, PPM_VIEW } from './types.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any;

/** Runs the segmentation network: RGB float32 NCHW in [0,1] -> logits (H*W). */
export type ModelRunner = (input: Float32Array, h: number, w: number) => Promise<Float32Array>;

/** AI segmentation of a 3 px/mm RGBA zone image -> probability map. */
export async function modelSegment(rgba: Uint8ClampedArray, w: number, h: number, run: ModelRunner): Promise<Float32Array> {
  const H = Math.ceil(h / 32) * 32, W = Math.ceil(w / 32) * 32;
  const x = new Float32Array(3 * H * W);
  const plane = H * W;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(y, h - 1);
    for (let xx = 0; xx < W; xx++) {
      const sx = Math.min(xx, w - 1);
      const si = (sy * w + sx) * 4, di = y * W + xx;
      x[di] = rgba[si] / 255;
      x[plane + di] = rgba[si + 1] / 255;
      x[2 * plane + di] = rgba[si + 2] / 255;
    }
  }
  const logits = await run(x, H, W);
  const prob = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) prob[y * w + xx] = 1 / (1 + Math.exp(-logits[y * W + xx]));
  return prob;
}

/**
 * Classical baseline (no AI): normalise the paper illumination, combine
 * "darker than paper" and Canny edges, close the gaps and fill the enclosed
 * region. Works well with the light box, struggles with reflections.
 * Input: 6 px/mm RGBA cv.Mat. Output: probability map at 3 px/mm.
 */
export function classicSegment(cv: CV, view: any): Float32Array {
  const mats: any[] = [];
  const M = () => {
    const m = new cv.Mat();
    mats.push(m);
    return m;
  };
  try {
    const gray = M(), bg = M(), norm = M(), blur = M(), edges = M(), dark = M(), comb = M(), closed = M();
    cv.cvtColor(view, gray, cv.COLOR_RGBA2GRAY);
    const kBig = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(31, 31));
    cv.morphologyEx(gray, bg, cv.MORPH_CLOSE, kBig);
    kBig.delete();
    cv.GaussianBlur(bg, bg, new cv.Size(0, 0), 12);
    cv.divide(gray, bg, norm, 255, cv.CV_8U);
    cv.GaussianBlur(norm, blur, new cv.Size(0, 0), 1.2);
    cv.Canny(blur, edges, 18, 45);
    cv.threshold(blur, dark, 232, 255, cv.THRESH_BINARY_INV);
    cv.bitwise_or(edges, dark, comb);
    const k5 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    cv.morphologyEx(comb, closed, cv.MORPH_CLOSE, k5);
    k5.delete();
    // fill enclosed regions: flood the background from a 1-px padded border
    const W = closed.cols, H = closed.rows;
    const pad = M();
    cv.copyMakeBorder(closed, pad, 1, 1, 1, 1, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const mask = M();
    mask.create(H + 4, W + 4, cv.CV_8U);
    mask.setTo(new cv.Scalar(0));
    const flood = pad.clone();
    mats.push(flood);
    cv.floodFill(flood, mask, new cv.Point(0, 0), new cv.Scalar(128));
    const filled = new Uint8Array(W * H);
    const fd = flood.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) filled[y * W + x] = fd[(y + 1) * (W + 2) + x + 1] === 128 ? 0 : 255;
    const fm = cv.matFromArray(H, W, cv.CV_8U, filled);
    mats.push(fm);
    const k7 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
    cv.morphologyEx(fm, fm, cv.MORPH_OPEN, k7);
    k7.delete();
    // shrink back the closing dilation (~1 px) and go to 3 px/mm
    const f32 = M();
    fm.convertTo(f32, cv.CV_32F, 1 / 255);
    const small = M();
    const f = PPM_MODEL / PPM_VIEW;
    cv.resize(f32, small, new cv.Size(Math.round(W * f), Math.round(H * f)), 0, 0, cv.INTER_AREA);
    return new Float32Array(small.data32F);
  } finally {
    mats.forEach((m) => m.delete());
  }
}

export interface ContourResult {
  contour: Poly; // mat millimetres
  touchesBorder: boolean;
  confidence: number; // mean |2p-1| in the boundary band
  solidity: number;
  areaMm2: number;
  candidates: number;
}

/**
 * Pick a lens component in a probability map (rank 0 = largest, 1 = second
 * largest...) and extract a sub-pixel, smoothed outline (in mat mm).
 * (x0, y0) = mm position of the map's left/top edge, ppm = map resolution.
 */
export function probToContour(cv: CV, prob: Float32Array, w: number, h: number, ppm: number, x0: number, y0: number, rank = 0): ContourResult | null {
  const mats: any[] = [];
  try {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = prob[i] > 0.5 ? 1 : 0;
    const binM = cv.matFromArray(h, w, cv.CV_8U, bin);
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    mats.push(binM, labels, stats, cents);
    const n = cv.connectedComponentsWithStats(binM, labels, stats, cents, 8, cv.CV_32S);
    const minA = 300 * ppm * ppm, maxA = 6000 * ppm * ppm;
    const cands: { i: number; a: number }[] = [];
    for (let i = 1; i < n; i++) {
      const a = stats.intAt(i, cv.CC_STAT_AREA);
      if (a >= minA && a <= maxA) cands.push({ i, a });
    }
    cands.sort((p, q) => q.a - p.a);
    const candidates = cands.length;
    if (rank >= candidates) return null;
    const best = cands[rank].i;
    const L = labels.data32S;
    const comp = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) comp[i] = L[i] === best ? 255 : 0;
    const left = stats.intAt(best, cv.CC_STAT_LEFT), top = stats.intAt(best, cv.CC_STAT_TOP);
    const bw = stats.intAt(best, cv.CC_STAT_WIDTH), bh = stats.intAt(best, cv.CC_STAT_HEIGHT);
    const touchesBorder = left <= 1 || top <= 1 || left + bw >= w - 1 || top + bh >= h - 1;

    // fill holes (reflections inside the lens) via the external contour
    const compM = cv.matFromArray(h, w, cv.CV_8U, comp);
    mats.push(compM);
    const cs = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(compM, cs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const filledM = cv.Mat.zeros(h, w, cv.CV_8U);
    mats.push(filledM, hier);
    cv.drawContours(filledM, cs, -1, new cv.Scalar(255), -1);
    cs.delete();
    const er = new cv.Mat(), di = new cv.Mat();
    mats.push(er, di);
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.erode(filledM, er, k);
    cv.dilate(filledM, di, k);
    k.delete();
    // soft map: 1 deep inside, 0 far outside, the network probability in the band
    const soft = new Float32Array(w * h);
    let confS = 0, confN = 0;
    for (let i = 0; i < w * h; i++) {
      if (er.data[i]) soft[i] = 1;
      else if (di.data[i]) {
        soft[i] = prob[i];
        confS += Math.abs(2 * prob[i] - 1);
        confN++;
      } else soft[i] = 0;
    }
    // sub-pixel iso-0.5 line: upsample x4, threshold, trace
    const up = 4;
    const softM = cv.matFromArray(h, w, cv.CV_32F, soft);
    const upM = new cv.Mat(), upB = new cv.Mat();
    mats.push(softM, upM, upB);
    cv.resize(softM, upM, new cv.Size(w * up, h * up), 0, 0, cv.INTER_LINEAR);
    cv.threshold(upM, upM, 0.5, 255, cv.THRESH_BINARY);
    upM.convertTo(upB, cv.CV_8U);
    const cs2 = new cv.MatVector(), h2 = new cv.Mat();
    mats.push(h2);
    cv.findContours(upB, cs2, h2, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let bi = -1, bl = 0;
    for (let i = 0; i < cs2.size(); i++) {
      const l = cs2.get(i).rows;
      if (l > bl) (bl = l), (bi = i);
    }
    if (bi < 0) {
      cs2.delete();
      return null;
    }
    const d = cs2.get(bi).data32S;
    const pts: Poly = [];
    for (let i = 0; i < d.length; i += 2) {
      const u = (d[i] + 0.5) / up - 0.5, v = (d[i + 1] + 0.5) / up - 0.5;
      pts.push([x0 + (u + 0.5) / ppm, y0 + (v + 0.5) / ppm]);
    }
    cs2.delete();
    // findContours traces the centres of the boundary pixels, half an
    // up-sampled pixel inside the true iso-line: push the outline back out.
    const contour = smoothContour(pts, 0.5 / (up * ppm));
    const a = area(contour);
    const hull = convexHull(contour);
    return {
      contour,
      touchesBorder,
      confidence: confN ? confS / confN : 0,
      solidity: a / Math.max(1e-9, area(hull)),
      areaMm2: a,
      candidates,
    };
  } finally {
    mats.forEach((m) => m.delete());
  }
}

/** Resample + Fourier low-pass, then push outward by `grow` mm. */
export function smoothContour(p: Poly, grow = 0, n = 720, k = 60): Poly {
  let q = fourierSmooth(resample(p, n), k);
  if (grow) q = offsetNormal(q, grow);
  return resample(q, n);
}
