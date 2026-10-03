// Photo -> lens contours in millimetres.
//
//  1. ArUco markers (downscaled detection + full-res line-fit refinement)
//  2. Homography mat-mm -> image-px from every marker corner (RANSAC + LSQ)
//  3. For each fully visible zone: rectified top view (6 and 3 px/mm)
//  4. Segmentation (AI model, classical fallback) -> sub-pixel outline
//  5. Edge refinement on the original photo, smoothing
//  6. Parallax / print-scale / bias corrections
//
// This module is shared by the Web Worker (browser) and the Node benchmark.

import { offsetNormal, centroid, type Vec2 } from '../core/geom.ts';
import { applyH, cameraPose, correctParallax, localScale, mul3, type Mat3 } from '../core/homography.ts';
import { MAT, MARKER_BY_ID, type Eye } from '../core/mat.ts';
import { detectMarkers, refineMarker, type Gray } from './aruco.ts';
import { M } from './messages.ts';
import { refineContour } from './refine.ts';
import { classicSegment, modelSegment, probToContour, smoothContour, type ModelRunner } from './segment.ts';
import {
  PPM_MODEL,
  PPM_VIEW,
  ZONE_MARGIN,
  type ImagePatch,
  type LiveDetection,
  type MarkerDet,
  type Msg,
  type PipelineOptions,
  type PipelineResult,
  type RGBAImage,
  type ZoneResult,
} from './types.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any;

const DETECT_MAX_SIDE = 1600;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface Engine {
  cv: CV;
  model?: ModelRunner | null;
}

function matToArray(m: any): number[] {
  const out: number[] = [];
  for (let i = 0; i < 9; i++) out.push(m.doubleAt(Math.floor(i / 3), i % 3));
  return out;
}

/** Downscaled grey copy for marker detection; returns the scale factor. */
function detectionImage(cv: CV, gray: any): { img: any; s: number } {
  const maxSide = Math.max(gray.cols, gray.rows);
  if (maxSide <= DETECT_MAX_SIDE) return { img: gray.clone(), s: 1 };
  const s = DETECT_MAX_SIDE / maxSide;
  const img = new cv.Mat();
  cv.resize(gray, img, new cv.Size(Math.round(gray.cols * s), Math.round(gray.rows * s)), 0, 0, cv.INTER_AREA);
  return { img, s };
}

/** Pixel-centre aware mapping from a resized image back to the original. */
const unscale = (p: Vec2, s: number): Vec2 => [(p[0] + 0.5) / s - 0.5, (p[1] + 0.5) / s - 0.5];

function fitHomography(cv: CV, markers: MarkerDet[]): { H: Mat3; residPx: number[]; inliers: boolean[] } | null {
  const src: number[] = [], dst: number[] = [];
  for (const m of markers) {
    const spec = MARKER_BY_ID.get(m.id)!;
    for (let k = 0; k < 4; k++) {
      src.push(spec.corners[k][0], spec.corners[k][1]);
      dst.push(m.corners[k][0], m.corners[k][1]);
    }
  }
  const n = src.length / 2;
  const sM = cv.matFromArray(n, 1, cv.CV_32FC2, src);
  const dM = cv.matFromArray(n, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  let Hm: any = null;
  try {
    Hm = cv.findHomography(sM, dM, cv.RANSAC, 4.0, mask);
    if (Hm.empty()) return null;
    let H = matToArray(Hm);
    // least-squares refit on the inliers
    const inl: boolean[] = [];
    for (let i = 0; i < n; i++) inl.push(mask.data[i] !== 0);
    const nIn = inl.filter(Boolean).length;
    if (nIn >= 8 && nIn < n) {
      const s2: number[] = [], d2: number[] = [];
      for (let i = 0; i < n; i++) if (inl[i]) s2.push(src[2 * i], src[2 * i + 1]), d2.push(dst[2 * i], dst[2 * i + 1]);
      const a = cv.matFromArray(nIn, 1, cv.CV_32FC2, s2), b = cv.matFromArray(nIn, 1, cv.CV_32FC2, d2);
      const H2 = cv.findHomography(a, b, 0);
      if (!H2.empty()) H = matToArray(H2);
      a.delete(), b.delete(), H2.delete();
    } else if (nIn === n) {
      const H2 = cv.findHomography(sM, dM, 0);
      if (!H2.empty()) H = matToArray(H2);
      H2.delete();
    }
    const residPx: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = applyH(H, src[2 * i], src[2 * i + 1]);
      residPx.push(Math.hypot(p[0] - dst[2 * i], p[1] - dst[2 * i + 1]));
    }
    return { H, residPx, inliers: inl };
  } finally {
    sM.delete(), dM.delete(), mask.delete();
    if (Hm) Hm.delete();
  }
}

function zoneRect(zone: Eye) {
  const z = MAT.zones[zone];
  return { x0: z.x - ZONE_MARGIN, y0: z.y - ZONE_MARGIN, w: z.w + 2 * ZONE_MARGIN, h: z.h + 2 * ZONE_MARGIN };
}

function zoneVisible(H: Mat3, zone: Eye, W: number, Hh: number): boolean {
  const r = zoneRect(zone);
  const pts: Vec2[] = [
    [r.x0, r.y0],
    [r.x0 + r.w, r.y0],
    [r.x0 + r.w, r.y0 + r.h],
    [r.x0, r.y0 + r.h],
  ];
  return pts.every((p) => {
    const [u, v] = applyH(H, p[0], p[1]);
    return u >= -2 && v >= -2 && u <= W + 1 && v <= Hh + 1;
  });
}

/** Lightweight detection for the live camera overlay. */
export function detectLive(cv: CV, img: RGBAImage): LiveDetection {
  const src = cv.matFromImageData(img as any);
  const gray = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const ms = detectMarkers(cv, gray);
    const res: LiveDetection = {
      markers: ms.map((m) => ({ id: m.id, corners: m.corners.map(([x, y]) => [x / img.width, y / img.height] as Vec2) })),
      zonesVisible: [],
    };
    if (ms.length >= 3) {
      const fit = fitHomography(
        cv,
        ms.map((m) => ({ ...m, refined: false, edgeSpreadPx: NaN })),
      );
      if (fit) {
        res.zonesVisible = (['OD', 'OS'] as Eye[]).filter((z) => zoneVisible(fit.H, z, img.width, img.height));
        res.tiltDeg = cameraPose(fit.H, img.width, img.height).tiltDeg;
      }
    }
    return res;
  } finally {
    src.delete();
    gray.delete();
  }
}

function patchFromMat(m: any, ppm: number, x0: number, y0: number): ImagePatch {
  return { data: new Uint8ClampedArray(m.data), width: m.cols, height: m.rows, ppm, x0, y0 };
}

function probPatch(prob: Float32Array, w: number, h: number, x0: number, y0: number): ImagePatch {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(prob[i] * 255);
    data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = v;
    data[4 * i + 3] = 255;
  }
  return { data, width: w, height: h, ppm: PPM_MODEL, x0, y0 };
}

export async function processPhoto(engine: Engine, img: RGBAImage, opts: PipelineOptions, onStage?: (s: string) => void): Promise<PipelineResult> {
  const { cv } = engine;
  const t0 = now();
  const timings: Record<string, number> = {};
  const lap = (k: string, t: number) => (timings[k] = Math.round(now() - t));
  const res: PipelineResult = {
    ok: false,
    errors: [],
    warnings: [],
    image: { width: img.width, height: img.height },
    markers: [],
    zones: [],
    timings,
    modelUsed: false,
  };
  const mats: any[] = [];
  const track = <T,>(m: T) => (mats.push(m), m);
  try {
    onStage?.('markers');
    let t = now();
    const src = track(cv.matFromImageData(img as any));
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // copy: views into the wasm heap are invalidated if the heap grows later
    const g: Gray = { data: new Uint8Array(gray.data), width: gray.cols, height: gray.rows };
    const det = detectionImage(cv, gray);
    track(det.img);
    const raw = detectMarkers(cv, det.img).map((m) => ({ id: m.id, corners: m.corners.map((p) => unscale(p, det.s)) }));
    res.markers = raw.map((m) => refineMarker(g, m.id, m.corners));
    lap('markers', t);

    if (res.markers.length === 0) return (res.errors.push(M.noMarkers()), res);
    if (res.markers.length < 3) return (res.errors.push(M.fewMarkers(res.markers.length)), res);

    t = now();
    const fit = fitHomography(cv, res.markers);
    if (!fit) return (res.errors.push(M.noMarkers()), res);
    const H = fit.H;
    res.H = H;
    lap('homography', t);

    // ---- quality
    const cx = MAT.page.w / 2, cy = MAT.page.h / 2;
    const pxPerMm = localScale(H, cx, cy);
    const inl = fit.residPx.filter((_, i) => fit.inliers[i]);
    const rms = Math.sqrt(inl.reduce((s, r) => s + r * r, 0) / Math.max(1, inl.length));
    const spreads = res.markers.map((m) => m.edgeSpreadPx).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const spreadPx = spreads.length ? spreads[Math.floor(spreads.length / 2)] : NaN;
    const pose = cameraPose(H, img.width, img.height);
    res.pose = pose;
    res.quality = {
      nMarkers: res.markers.length,
      reprojPx: rms,
      reprojMm: rms / pxPerMm,
      pxPerMm,
      blurMm: spreadPx / pxPerMm,
      tiltDeg: pose.tiltDeg,
      cameraHeight: pose.height,
    };
    const q = res.quality;
    if (q.blurMm > 0.9 || q.pxPerMm < 2.5) return (res.errors.push(M.blurry(q.blurMm)), res);
    if (q.blurMm > 0.5) res.warnings.push(M.slightlyBlurry(q.blurMm));
    if (q.reprojMm > 0.6) res.warnings.push(M.notFlat(q.reprojMm));
    if (q.tiltDeg > 40) res.warnings.push(M.tilted(q.tiltDeg));

    // ---- rectification source: downscale so that warping does not alias
    const zones = (['OD', 'OS'] as Eye[]).filter((z) => zoneVisible(H, z, img.width, img.height));
    if (!zones.length) return (res.errors.push(M.noZone()), res);
    t = now();
    const srcPpm = Math.min(...zones.map((z) => localScale(H, MAT.zones[z].x + MAT.zones[z].w / 2, MAT.zones[z].y + MAT.zones[z].h / 2)));
    const s = Math.min(1, (PPM_VIEW * 1.5) / srcPpm);
    let warpSrc = src;
    let Hs = H;
    if (s < 0.9) {
      warpSrc = track(new cv.Mat());
      cv.resize(src, warpSrc, new cv.Size(Math.round(src.cols * s), Math.round(src.rows * s)), 0, 0, cv.INTER_AREA);
      Hs = mul3([s, 0, 0.5 * s - 0.5, 0, s, 0.5 * s - 0.5, 0, 0, 1], H);
    }
    lap('downscale', t);

    let anyLens = false;
    for (const zone of zones) {
      const zr = zoneRect(zone);
      const zres: ZoneResult = { zone, status: 'empty', messages: [], method: 'ai' };
      res.zones.push(zres);
      onStage?.('rectify');
      t = now();
      const W6 = Math.round(zr.w * PPM_VIEW), H6 = Math.round(zr.h * PPM_VIEW);
      const S6 = [1 / PPM_VIEW, 0, zr.x0 + 0.5 / PPM_VIEW, 0, 1 / PPM_VIEW, zr.y0 + 0.5 / PPM_VIEW, 0, 0, 1];
      const Mw = mul3(Hs, S6);
      const MwM = track(cv.matFromArray(3, 3, cv.CV_64F, Mw));
      const view = track(new cv.Mat());
      cv.warpPerspective(warpSrc, view, MwM, new cv.Size(W6, H6), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
      const small = track(new cv.Mat());
      const W3 = Math.round(W6 * (PPM_MODEL / PPM_VIEW)), H3 = Math.round(H6 * (PPM_MODEL / PPM_VIEW));
      cv.resize(view, small, new cv.Size(W3, H3), 0, 0, cv.INTER_AREA);
      lap(`rectify_${zone}`, t);

      onStage?.('segment');
      t = now();
      let prob: Float32Array;
      if (opts.useModel && engine.model) {
        prob = await modelSegment(small.data, W3, H3, engine.model);
        res.modelUsed = true;
      } else {
        prob = classicSegment(cv, view);
        zres.method = 'classic';
      }
      lap(`segment_${zone}`, t);
      if (opts.debug) {
        zres.view = patchFromMat(view, PPM_VIEW, zr.x0, zr.y0);
        zres.prob = probPatch(prob, W3, H3, zr.x0, zr.y0);
      }

      onStage?.('contour');
      t = now();
      const cr = probToContour(cv, prob, W3, H3, PPM_MODEL, zr.x0, zr.y0);
      if (!cr) {
        lap(`contour_${zone}`, t);
        continue;
      }
      anyLens = true;
      zres.status = 'ok';
      zres.coarse = cr.contour;
      zres.confidence = cr.confidence;
      zres.solidity = cr.solidity;
      let contour = cr.contour;
      if (opts.refine) {
        const r = refineContour(g, H, contour);
        contour = smoothContour(r.contour);
        zres.refine = r.stats;
      }
      // corrections: parallax (edge above the paper), print scale, bias
      contour = correctParallax(contour, pose, opts.edgeHeight);
      if (opts.printScale !== 1) {
        const c = centroid(contour);
        contour = contour.map(([x, y]) => [c[0] + (x - c[0]) * opts.printScale, c[1] + (y - c[1]) * opts.printScale]);
      }
      if (opts.bias) contour = offsetNormal(contour, opts.bias);
      zres.contour = contour;
      lap(`contour_${zone}`, t);

      const msgs: Msg[] = [];
      const xs = contour.map((p) => p[0]), ys = contour.map((p) => p[1]);
      const A = Math.max(...xs) - Math.min(...xs), B = Math.max(...ys) - Math.min(...ys);
      if (cr.touchesBorder) msgs.push(M.lensBorder());
      if (A < 20 || A > 80 || B < 15 || B > 70) msgs.push(M.lensSize(A, B));
      if (cr.confidence < 0.6) msgs.push(M.lowConfidence());
      if (cr.solidity < 0.9) msgs.push(M.irregular());
      if (msgs.length) zres.status = 'warn';
      zres.messages = msgs;
    }
    if (!anyLens) res.errors.push(M.noLens());
    if (opts.useModel && !engine.model) res.warnings.push(M.classicFallback());
    res.ok = anyLens;
    return res;
  } catch (e) {
    res.errors.push(M.failed(e));
    return res;
  } finally {
    mats.forEach((m) => {
      try {
        m.delete();
      } catch {
        /* already freed */
      }
    });
    timings.total = Math.round(now() - t0);
  }
}
