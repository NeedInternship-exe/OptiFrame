// Frame generator check: two DIFFERENT lens shapes -> closed STL + groove check.
//   node bench/test-frame.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Poly } from '../src/core/geom.ts';
import { buildFrame, DEFAULT_FRAME, toSTL } from '../src/frame/frame.ts';

function superellipse(A: number, B: number, p: number, n = 720): Poly {
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n, c = Math.cos(t), s = Math.sin(t);
    const r = (Math.abs(c / (A / 2)) ** p + Math.abs(s / (B / 2)) ** p) ** (-1 / p);
    out.push([r * c, r * s]);
  }
  return out;
}

const od = superellipse(50, 36, 2); // the 50 x 36 mm ellipse of the brief
const os = superellipse(52, 34, 4); // rounded rectangle, different shape
const res = await buildFrame(
  [
    { eye: 'OD', contour: od },
    { eye: 'OS', contour: os },
  ],
  DEFAULT_FRAME,
);
const fail: string[] = [];
console.log(`built in ${res.ms} ms, ${res.triangles} triangles, volume ${(res.volume / 1000).toFixed(2)} cm³, genus ${res.genus}`);
console.log(`size ${res.size.map((v) => v.toFixed(1)).join(' x ')} mm, thickness ${res.thickness.toFixed(2)} mm, open edges ${res.openEdges}`);
for (const c of res.checks)
  console.log(`${c.eye}: groove gap mean ${c.meanGap.toFixed(3)} [${c.minGap.toFixed(3)}, ${c.maxGap.toFixed(3)}] mm, front lip overlap ${c.lipMean.toFixed(3)} mm`);
if (!res.watertight) fail.push('mesh not watertight');
if (res.checks.length !== 2) fail.push('groove check missing');
for (const c of res.checks) {
  if (Math.abs(c.meanGap - DEFAULT_FRAME.clearance) > 0.05) fail.push(`${c.eye} groove gap ${c.meanGap}`);
  if (Math.abs(c.lipMean - DEFAULT_FRAME.lipFront) > 0.05) fail.push(`${c.eye} lip ${c.lipMean}`);
}
mkdirSync('bench/out', { recursive: true });
writeFileSync('bench/out/monture-test.stl', Buffer.from(toSTL(res.positions)));
console.log(fail.length ? `FAIL: ${fail.join('; ')}` : 'OK - bench/out/monture-test.stl');
process.exit(fail.length ? 1 : 0);
