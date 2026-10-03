// End-to-end benchmark: run the web-app pipeline on photos with known outlines.
//
//   node bench/run.ts [--dir bench/photos] [--no-model] [--no-refine] [--edge 0] [--out name]
//
// For each lens: |A_measured - A_true|, |B_measured - B_true| (same boxing
// procedure on both outlines) and the mean distance between the outlines.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { distToPoly, type Poly } from '../src/core/geom.ts';
import { measureLens } from '../src/core/measure.ts';
import { processPhoto } from '../src/vision/pipeline.ts';
import { DEFAULT_OPTIONS, type PipelineOptions } from '../src/vision/types.ts';
import { loadEngine, readJpeg } from './node-engine.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const val = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

const dir = val('--dir', 'bench/photos');
const opts: PipelineOptions = {
  ...DEFAULT_OPTIONS,
  useModel: !flag('--no-model'),
  refine: !flag('--no-refine'),
  edgeHeight: Number(val('--edge', '0')), // synthetic lenses are flat
  debug: false,
};
const limit = Number(val('--limit', '1000'));

interface GT {
  file: string;
  mode: string;
  backlit: boolean;
  camera: { tilt_deg: number };
  lenses: { zone: 'OD' | 'OS'; poly: Poly }[];
}

const gt: GT[] = JSON.parse(readFileSync(join(dir, 'ground_truth.json'), 'utf8')).slice(0, limit);
const engine = await loadEngine(opts.useModel);
console.log(`engine: opencv ✓  model ${engine.model ? '✓' : '✗ (classic)'}  refine ${opts.refine ? 'on' : 'off'}`);

const rows: Record<string, unknown>[] = [];
let missed = 0;
for (const g of gt) {
  const img = readJpeg(join(dir, g.file));
  const res = await processPhoto(engine, img, opts);
  for (const lens of g.lenses) {
    const z = res.zones.find((zz) => zz.zone === lens.zone);
    if (!z?.contour) {
      missed++;
      rows.push({ file: g.file, zone: lens.zone, ok: false, error: res.errors.map((e) => e.code).join(',') || z?.status });
      continue;
    }
    const t = measureLens(lens.poly, true).measures;
    const m = measureLens(z.contour, true).measures;
    let dsum = 0;
    for (const p of z.contour) dsum += distToPoly(p, lens.poly);
    rows.push({
      file: g.file,
      zone: lens.zone,
      ok: true,
      light: g.backlit ? 'backlit' : 'ambient',
      tilt: Math.round(g.camera.tilt_deg),
      A_true: +t.A.toFixed(2),
      B_true: +t.B.toFixed(2),
      dA: +(m.A - t.A).toFixed(3),
      dB: +(m.B - t.B).toFixed(3),
      contour_mm: +(dsum / z.contour.length).toFixed(3),
      reproj_mm: +(res.quality?.reprojMm ?? NaN).toFixed(3),
      markers: res.quality?.nMarkers,
      ms: res.timings.total,
    });
  }
  const last = rows.slice(-g.lenses.length);
  console.log(g.file, last.map((r) => (r.ok ? `${r.zone} dA=${r.dA} dB=${r.dB} c=${r.contour_mm}` : `${r.zone} MISSED ${r.error}`)).join('  |  '), `${res.timings.total} ms`);
}

const ok = rows.filter((r) => r.ok) as { dA: number; dB: number; contour_mm: number; light: string; ms: number }[];
const mae = (xs: number[]) => xs.reduce((s, v) => s + Math.abs(v), 0) / Math.max(1, xs.length);
const summary = {
  config: { model: !!engine.model, refine: opts.refine },
  lenses: rows.length,
  detected: ok.length,
  missed,
  A_mae: +mae(ok.map((r) => r.dA)).toFixed(3),
  B_mae: +mae(ok.map((r) => r.dB)).toFixed(3),
  AB_mae: +mae(ok.flatMap((r) => [r.dA, r.dB])).toFixed(3),
  AB_max: +Math.max(...ok.flatMap((r) => [Math.abs(r.dA), Math.abs(r.dB)])).toFixed(3),
  A_bias: +(ok.reduce((s, r) => s + r.dA, 0) / Math.max(1, ok.length)).toFixed(3),
  B_bias: +(ok.reduce((s, r) => s + r.dB, 0) / Math.max(1, ok.length)).toFixed(3),
  contour_mean_mm: +mae(ok.map((r) => r.contour_mm)).toFixed(3),
  within_1mm: +(ok.filter((r) => Math.abs(r.dA) <= 1 && Math.abs(r.dB) <= 1).length / Math.max(1, rows.length)).toFixed(3),
  ambient_AB_mae: +mae(ok.filter((r) => r.light === 'ambient').flatMap((r) => [r.dA, r.dB])).toFixed(3),
  backlit_AB_mae: +mae(ok.filter((r) => r.light === 'backlit').flatMap((r) => [r.dA, r.dB])).toFixed(3),
  mean_ms_per_photo: Math.round(ok.reduce((s, r) => s + r.ms, 0) / Math.max(1, ok.length)),
};
console.log('\nSUMMARY', JSON.stringify(summary, null, 1));
const name = val('--out', `${engine.model ? 'ai' : 'classic'}${opts.refine ? '+refine' : ''}`);
writeFileSync(join('bench', `results-${name}.json`), JSON.stringify({ summary, rows }, null, 1));
