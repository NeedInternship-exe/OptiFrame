// Canvas drawings: control images, step-by-step views.
import { bbox, rotate, type Poly, type Vec2 } from '../core/geom.ts';
import { fmt, type Measures } from '../core/measure.ts';
import type { ImagePatch, MarkerDet } from '../vision/types.ts';

export const COLORS = { contour: '#16a34a', coarse: '#f97316', box: '#0ea5e9', marker: '#22c55e', text: '#ffffff' };

export function patchCanvas(p: ImagePatch): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = p.width;
  c.height = p.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  return c;
}

/** Boxing rectangle corners expressed in the raw (mat) frame. */
export function boxingRaw(raw: Poly, angle: number): Poly {
  const r = angle ? rotate(raw, angle) : raw;
  const b = bbox(r);
  const rect: Poly = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ];
  return angle ? rotate(rect, -angle) : rect;
}

interface View {
  ctx: CanvasRenderingContext2D;
  k: number; // canvas px per mm
  x0: number; // mm at canvas x = 0
  y0: number;
}
const P = (v: View, [x, y]: Vec2): Vec2 => [(x - v.x0) * v.k, (y - v.y0) * v.k];

function pathPoly(v: View, p: Poly) {
  v.ctx.beginPath();
  p.forEach((pt, i) => {
    const [x, y] = P(v, pt);
    if (i) v.ctx.lineTo(x, y);
    else v.ctx.moveTo(x, y);
  });
  v.ctx.closePath();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 13) {
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(15,23,42,0.78)';
  ctx.fillRect(x - w / 2 - 4, y - size + 1, w + 8, size + 5);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
}

/**
 * Control image: rectified top view cropped around the lens, with the
 * measured outline, the boxing rectangle and the A / B dimensions.
 */
export function drawControl(canvas: HTMLCanvasElement, patch: ImagePatch, raw: Poly, m: Measures, coarse?: Poly, widthPx = 640) {
  const b = bbox(raw);
  const pad = 7;
  const x0 = Math.max(patch.x0, b.minX - pad), y0 = Math.max(patch.y0, b.minY - pad);
  const x1 = Math.min(patch.x0 + patch.width / patch.ppm, b.maxX + pad), y1 = Math.min(patch.y0 + patch.height / patch.ppm, b.maxY + pad);
  const k = widthPx / (x1 - x0);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(widthPx * dpr);
  canvas.height = Math.round((y1 - y0) * k * dpr);
  canvas.style.aspectRatio = `${x1 - x0} / ${y1 - y0}`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  const src = patchCanvas(patch);
  ctx.drawImage(src, (x0 - patch.x0) * patch.ppm, (y0 - patch.y0) * patch.ppm, (x1 - x0) * patch.ppm, (y1 - y0) * patch.ppm, 0, 0, widthPx, (y1 - y0) * k);
  const v: View = { ctx, k, x0, y0 };
  if (coarse) {
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = COLORS.coarse;
    ctx.lineWidth = 1.2;
    pathPoly(v, coarse);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const rect = boxingRaw(raw, m.angle);
  ctx.strokeStyle = COLORS.box;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([6, 4]);
  pathPoly(v, rect);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = COLORS.contour;
  ctx.lineWidth = 2;
  pathPoly(v, raw);
  ctx.stroke();
  // dimension labels at the middle of the top and right sides of the box
  const mid = (a: Vec2, c: Vec2): Vec2 => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  const top = P(v, mid(rect[0], rect[1])), right = P(v, mid(rect[1], rect[2]));
  label(ctx, `A ${fmt(m.A, 1)} mm`, top[0], Math.max(16, top[1] - 6));
  label(ctx, `B ${fmt(m.B, 1)} mm`, Math.min(widthPx - 50, right[0] + 2), right[1] + 5);
  // 10 mm scale bar
  const sb = 10 * k;
  ctx.fillStyle = 'rgba(15,23,42,0.78)';
  ctx.fillRect(8, (y1 - y0) * k - 22, sb + 50, 16);
  ctx.fillStyle = '#fff';
  ctx.fillRect(12, (y1 - y0) * k - 15, sb, 3);
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('10 mm', 16 + sb, (y1 - y0) * k - 10);
}

/** Probability map with the outline, same crop as drawControl. */
export function drawProb(canvas: HTMLCanvasElement, prob: ImagePatch, raw: Poly, widthPx = 640) {
  const tinted: ImagePatch = { ...prob, data: new Uint8ClampedArray(prob.data.length) };
  for (let i = 0; i < prob.data.length; i += 4) {
    const v = prob.data[i] / 255;
    // dark blue -> teal -> yellow
    tinted.data[i] = Math.round(255 * Math.min(1, Math.max(0, 2 * v - 0.6)));
    tinted.data[i + 1] = Math.round(255 * (0.15 + 0.75 * v));
    tinted.data[i + 2] = Math.round(255 * (0.45 + 0.1 * v - 0.4 * v * v));
    tinted.data[i + 3] = 255;
  }
  drawControl(canvas, tinted, raw, { A: NaN, B: NaN, perimeter: 0, area: 0, ed: 0, angle: 0 }, undefined, widthPx);
}

/** Downscaled photo with the detected markers. */
export function drawPhoto(canvas: HTMLCanvasElement, photo: ImageBitmap, srcW: number, srcH: number, markers: MarkerDet[], widthPx = 640) {
  const k = widthPx / srcW;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(widthPx * dpr);
  canvas.height = Math.round(srcH * k * dpr);
  canvas.style.aspectRatio = `${srcW} / ${srcH}`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(photo, 0, 0, widthPx, srcH * k);
  for (const m of markers) {
    ctx.strokeStyle = m.refined ? COLORS.marker : COLORS.coarse;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    m.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
    ctx.closePath();
    ctx.stroke();
    const cx = m.corners.reduce((s, p) => s + p[0], 0) / 4, cy = m.corners.reduce((s, p) => s + p[1], 0) / 4;
    label(ctx, `#${m.id}`, cx * k, cy * k + 5, 12);
  }
}

/** Small outline thumbnail as an SVG path string (lens frame, y down). */
export function outlinePath(p: Poly, size: number, pad = 4): { d: string; w: number; h: number } {
  const b = bbox(p);
  const s = (size - 2 * pad) / Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const w = (b.maxX - b.minX) * s + 2 * pad, h = (b.maxY - b.minY) * s + 2 * pad;
  const d = p.map(([x, y], i) => `${i ? 'L' : 'M'}${((x - b.minX) * s + pad).toFixed(1)},${((y - b.minY) * s + pad).toFixed(1)}`).join('') + 'Z';
  return { d, w, h };
}
