// "Capture appariée": collect REAL training images without manual labelling.
//
// 1. Reference shot on the light box: the lens edge is crisp, the outline is
//    reliable. 2. Without moving the lenses, more shots in harder conditions
//    (room light, reflections, other angles). Every photo is rectified in mat
//    millimetres, so the reference outline labels the hard shots exactly.
// Samples live in IndexedDB (too big for localStorage) and are exported as one
// JSON file, converted for training by ml/import_real.py.

import { distToPoly, type Poly } from '../core/geom.ts';
import type { Eye } from '../core/mat.ts';
import type { ImagePatch, PipelineResult } from '../vision/types.ts';

export interface Sample {
  id: string;
  series: string;
  zone: Eye;
  time: number;
  role: 'reference' | 'hard';
  image: string; // PNG data URL of the rectified zone at 3 px/mm
  ppm: number;
  x0: number;
  y0: number;
  label: Poly; // reference outline (mat mm)
  pred: Poly | null; // outline found on this photo
  meanDev: number | null; // mean distance pred <-> label (mm): detects a moved lens
}

const DB = 'optiframe-collect', STORE = 'samples';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const allSamples = () => tx<Sample[]>('readonly', (s) => s.getAll() as IDBRequest<Sample[]>);
export const clearSamples = () => tx('readwrite', (s) => s.clear());

/** 6 px/mm control view -> 3 px/mm PNG (the model's resolution). */
function patchToPng(p: ImagePatch): string {
  const src = document.createElement('canvas');
  src.width = p.width;
  src.height = p.height;
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  const dst = document.createElement('canvas');
  dst.width = Math.round(p.width / 2);
  dst.height = Math.round(p.height / 2);
  const ctx = dst.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
  return dst.toDataURL('image/png');
}

/** Store the zones of a run. The first run of a series becomes the reference. */
export async function collectRun(res: PipelineResult, series: string, reference: Partial<Record<Eye, Poly>>): Promise<{ stored: number; reference: Partial<Record<Eye, Poly>>; moved: Eye[] }> {
  const ref = { ...reference };
  const moved: Eye[] = [];
  let stored = 0;
  for (const z of res.zones) {
    if (!z.view) continue;
    const isRef = !ref[z.zone];
    if (isRef) {
      if (!z.contour) continue; // a reference needs an outline
      ref[z.zone] = z.contour;
    }
    const label = ref[z.zone]!;
    let meanDev: number | null = null;
    if (z.contour && !isRef) {
      const step = Math.max(1, Math.floor(z.contour.length / 120));
      let s = 0, n = 0;
      for (let i = 0; i < z.contour.length; i += step) (s += distToPoly(z.contour[i], label)), n++;
      meanDev = s / n;
      if (meanDev > 1.5) moved.push(z.zone);
    }
    const sample: Sample = {
      id: `${series}-${z.zone}-${Date.now()}-${stored}`,
      series,
      zone: z.zone,
      time: Date.now(),
      role: isRef ? 'reference' : 'hard',
      image: patchToPng(z.view),
      ppm: z.view.ppm / 2,
      x0: z.view.x0,
      y0: z.view.y0,
      label,
      pred: z.contour ?? null,
      meanDev,
    };
    await tx('readwrite', (s) => s.put(sample));
    stored++;
  }
  return { stored, reference: ref, moved };
}
