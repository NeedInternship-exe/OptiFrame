// Parametric spectacle front, built with manifold-3d (guaranteed closed mesh).
//
// Coordinates (mm) = print space, right-handed: the front face lies on the
// bed (z = 0), the back face (towards the wearer) is at z = T, y is "up" for
// the wearer. Seen from the front (i.e. from below the bed) the observer's
// right is -x, so front-view outlines are mirrored in x when placed: the
// right-eye lens (OD, observer's left in a front view) ends up at +x.
//
// Each rim holds its lens in a V-groove whose walls are at 45° so the front
// prints without supports. Radial profile of the opening along z:
//
//   z: 0 ── front wall ──┐ ramp 45° ┌─ groove (lens edge) ─┐ ramp 45° ┌─ back wall ── T
//   o:      -lipFront    └──────────┘       +clearance       └─────────┘    -lipBack
//
// o = offset from the measured lens outline (negative = lip over the lens).

import Module from 'manifold-3d';
import type { CrossSection as CS, Manifold as MF, ManifoldToplevel } from 'manifold-3d';
import { bbox, fourierSmooth, normals, resample, signedArea, type Poly, type Vec2 } from '../core/geom.ts';
import type { Eye } from '../core/mat.ts';

export interface FrameParams {
  bridge: number; // distance between lenses (DBL), mm
  rimWidth: number; // rim width beyond the lens edge, mm
  clearance: number; // radial play at the bottom of the groove, mm
  lipFront: number; // front lip overlap on the lens, mm
  lipBack: number; // back lip overlap (snap-in), mm
  edgeThickness: number; // lens edge thickness, mm
  frontWall: number; // solid front lip thickness, mm
  backWall: number; // solid back lip thickness, mm
  bridgeHeight: number; // bridge band height, mm
  hinges: boolean; // add temple endpieces (tenons) with hinge knuckles
}

export const DEFAULT_FRAME: FrameParams = {
  bridge: 18,
  rimWidth: 4,
  clearance: 0.2,
  lipFront: 0.8,
  lipBack: 0.4,
  edgeThickness: 2.0,
  frontWall: 0.8,
  backWall: 0.6,
  bridgeHeight: 5,
  hinges: true,
};

export interface LensInput {
  eye: Eye;
  contour: Poly; // lens frame: boxing centre at origin, y DOWN, front view
}

export interface PlacedLens {
  eye: Eye;
  outline: Poly; // print-space coordinates (see header), counter-clockwise
  center: Vec2;
}

/** Print space -> front view (x to the observer's right, y up). */
export const toFrontView = (p: Poly): Poly => p.map(([x, y]) => [-x, y] as Vec2);

export interface GrooveCheck {
  eye: Eye;
  meanGap: number; // mean distance lens outline -> groove bottom (mm)
  minGap: number;
  maxGap: number;
  lipMean: number; // mean overlap of the front lip (mm)
  groove: Poly; // groove outline from the slice of the real mesh
}

export interface FrameResult {
  positions: Float32Array; // non-indexed triangle soup for display / STL
  triangles: number;
  volume: number; // mm³
  genus: number;
  watertight: boolean;
  openEdges: number;
  size: [number, number, number];
  thickness: number;
  grooveZ: [number, number];
  lenses: PlacedLens[];
  checks: GrooveCheck[];
  ms: number;
}

let wasmP: Promise<ManifoldToplevel> | null = null;
export function loadManifold(): Promise<ManifoldToplevel> {
  wasmP ??= (async () => {
    const w = await Module();
    w.setup();
    return w;
  })();
  return wasmP;
}

/** z-profile of the lens opening: [z, offset] pairs from front to back. */
export function grooveProfile(p: FrameParams): { prof: [number, number][]; T: number; zGroove: [number, number] } {
  const c = p.clearance;
  const w = Math.max(0.3, p.edgeThickness - 2 * c);
  const z1 = p.frontWall;
  const z2 = z1 + p.lipFront + c;
  const z3 = z2 + w;
  const z4 = z3 + p.lipBack + c;
  const T = z4 + p.backWall;
  return {
    prof: [
      [-1, -p.lipFront],
      [z1, -p.lipFront],
      [z2, c],
      [z3, c],
      [z4, -p.lipBack],
      [T + 1, -p.lipBack],
    ],
    T,
    zGroove: [z2, z3],
  };
}

const ccw = (p: Poly): Poly => (signedArea(p) < 0 ? p.slice().reverse() : p);

/** Place both lenses: nasal edges `bridge` apart, boxing centres on y = 0. */
export function placeLenses(lenses: LensInput[], bridge: number): PlacedLens[] {
  return lenses.map((l) => {
    // lens frame (front view, y down) -> print space (mirror x, y up)
    const up = l.contour.map(([x, y]) => [-x, -y] as Vec2);
    const b = bbox(up);
    const halfA = (b.maxX - b.minX) / 2;
    const cx = l.eye === 'OD' ? bridge / 2 + halfA : -(bridge / 2 + halfA);
    const ox = cx - (b.minX + b.maxX) / 2, oy = -(b.minY + b.maxY) / 2;
    // smooth a little for the CAD (removes sub-0.1 mm wiggles)
    const outline = ccw(resample(fourierSmooth(resample(up, 512), 48), 512).map(([x, y]) => [x + ox, y + oy] as Vec2));
    return { eye: l.eye, outline, center: [cx, 0] };
  });
}

/** Lofted cutter following the groove profile (one closed mesh). */
function grooveCutter(w: ManifoldToplevel, outline: Poly, prof: [number, number][]): MF {
  const N = outline.length, R = prof.length;
  const nr = normals(outline);
  const vp = new Float32Array(R * N * 3);
  prof.forEach(([z, o], r) => {
    for (let i = 0; i < N; i++) {
      const k = (r * N + i) * 3;
      vp[k] = outline[i][0] + o * nr[i][0];
      vp[k + 1] = outline[i][1] + o * nr[i][1];
      vp[k + 2] = z;
    }
  });
  const tris: number[] = [];
  for (let r = 0; r < R - 1; r++)
    for (let i = 0; i < N; i++) {
      const a = r * N + i, b = r * N + ((i + 1) % N), c = (r + 1) * N + ((i + 1) % N), d = (r + 1) * N + i;
      tris.push(a, b, c, a, c, d);
    }
  const cap = (r: number, flip: boolean) => {
    const poly: Vec2[] = [];
    for (let i = 0; i < N; i++) poly.push([vp[(r * N + i) * 3], vp[(r * N + i) * 3 + 1]]);
    for (const [x, y, z] of w.triangulate([poly])) {
      if (flip) tris.push(r * N + x, r * N + z, r * N + y);
      else tris.push(r * N + x, r * N + y, r * N + z);
    }
  };
  cap(0, true);
  cap(R - 1, false);
  const m = new w.Manifold(new w.Mesh({ numProp: 3, vertProperties: vp, triVerts: new Uint32Array(tris) }));
  if (m.status() !== 'NoError' || m.volume() <= 0) throw new Error(`cutter ${m.status()}`);
  return m;
}

/** Fallback cutter: stack of thin offset slices (Clipper offsets, always valid). */
function steppedCutter(w: ManifoldToplevel, outline: Poly, prof: [number, number][], dz = 0.2): MF {
  const base = new w.CrossSection([outline]);
  const z0 = prof[0][0], z1 = prof[prof.length - 1][0];
  const parts: MF[] = [];
  for (let z = z0; z < z1 - 1e-6; z += dz) {
    const zm = z + dz / 2;
    let o = prof[prof.length - 1][1];
    for (let k = 0; k < prof.length - 1; k++) {
      const [za, oa] = prof[k], [zb, ob] = prof[k + 1];
      if (zm >= za && zm <= zb) o = oa + ((ob - oa) * (zm - za)) / Math.max(1e-9, zb - za);
    }
    parts.push(base.offset(o, 'Miter', 2).extrude(dz + 0.002).translate([0, 0, z - 0.001]));
  }
  return w.Manifold.union(parts);
}

function bridgeBand(w: ManifoldToplevel, placed: PlacedLens[], p: FrameParams): CS | null {
  const od = placed.find((l) => l.eye === 'OD'), os = placed.find((l) => l.eye === 'OS');
  if (!od || !os) return null;
  const hB = Math.min(bbox(od.outline).maxY, bbox(os.outline).maxY);
  const yb = 0.45 * hB; // bridge centre line, above the datum line
  const xa = od.center[0], xb = os.center[0];
  const half = p.bridge / 2, arch = 2.2;
  const top: Vec2[] = [], bot: Vec2[] = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const x = xa + ((xb - xa) * i) / n;
    const u = Math.abs(x) < half ? 1 - (x / half) ** 2 : 0;
    top.push([x, yb + p.bridgeHeight / 2 + 0.6 * arch * u]);
    bot.push([x, yb - p.bridgeHeight / 2 + arch * u]);
  }
  return new w.CrossSection([ccw([...bot, ...top.reverse()])]);
}

function endpieceTab(w: ManifoldToplevel, l: PlacedLens, p: FrameParams): { tab: CS; knuckle: Vec2; ye: number } {
  const b = bbox(l.outline);
  const dir = Math.sign(l.center[0]) || 1; // temporal side points away from the bridge
  const xt = dir > 0 ? b.maxX + p.rimWidth : b.minX - p.rimWidth;
  const ye = 0.35 * b.maxY;
  const out = 4 * dir;
  const x0 = l.center[0], x1 = xt + out;
  const r = [
    [Math.min(x0, x1), ye - 4],
    [Math.max(x0, x1), ye - 4],
    [Math.max(x0, x1), ye + 4],
    [Math.min(x0, x1), ye + 4],
  ] as Poly;
  // knuckle centred 2 mm in from the end of the tab, fully supported by it
  return { tab: new w.CrossSection([r]), knuckle: [x1 - out / 2, ye], ye };
}

/** Count edges not shared by exactly two triangles (0 = watertight). */
export function openEdgeCount(triVerts: Uint32Array): number {
  const m = new Map<string, number>();
  for (let t = 0; t < triVerts.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = triVerts[t + e], b = triVerts[t + ((e + 1) % 3)];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      m.set(k, (m.get(k) ?? 0) + (a < b ? 1 : 1000));
    }
  let open = 0;
  for (const v of m.values()) if (v !== 1001) open++; // one a->b and one b->a
  return open;
}

export async function buildFrame(lenses: LensInput[], p: FrameParams): Promise<FrameResult> {
  const t0 = performance.now();
  const w = await loadManifold();
  const { prof, T, zGroove } = grooveProfile(p);
  const placed = placeLenses(lenses, p.bridge);

  // 2D outline of the front: rims + bridge + endpiece tabs, corners rounded
  const parts: CS[] = placed.map((l) => new w.CrossSection([l.outline]).offset(p.rimWidth, 'Round', 2, 72));
  const band = bridgeBand(w, placed, p);
  if (band) parts.push(band);
  const knuckles: { at: Vec2; eye: Eye }[] = [];
  if (p.hinges)
    for (const l of placed) {
      const e = endpieceTab(w, l, p);
      parts.push(e.tab);
      knuckles.push({ at: e.knuckle, eye: l.eye });
    }
  const outline = w.CrossSection.union(parts).offset(-1.2, 'Round', 2, 48).offset(1.2, 'Round', 2, 48).offset(0.8, 'Round', 2, 48).offset(-0.8, 'Round', 2, 48);
  let body = outline.extrude(T);

  // lens openings with the V-groove
  for (const l of placed) {
    let cutter: MF;
    try {
      cutter = grooveCutter(w, l.outline, prof);
    } catch {
      cutter = steppedCutter(w, l.outline, prof);
    }
    body = body.subtract(cutter);
  }

  // hinge knuckles behind the endpieces, with a teardrop pin hole (Ø 1.8 mm,
  // fits 1.75 mm filament as the hinge pin) printable without support
  for (const k of knuckles) {
    const kw = 3.6, kh = 7, kd = 6;
    let block = w.Manifold.cube([kw, kh, kd], false).translate([k.at[0] - kw / 2, k.at[1] - kh / 2, T - 0.01]);
    // teardrop section: circle + 45° tip; after the rotation the tip points to
    // +z, i.e. upwards when the front is printed face down
    const rad = 0.9;
    const tear: Vec2[] = [];
    for (let i = 0; i <= 32; i++) {
      const a = 0.75 * Math.PI + (i / 32) * 1.5 * Math.PI;
      tear.push([rad * Math.cos(a), rad * Math.sin(a)]);
    }
    tear.push([0, rad * Math.SQRT2]);
    const hole = new w.CrossSection([ccw(tear)])
      .extrude(kh + 2)
      .rotate([90, 0, 0]) // extrusion axis -> -y (vertical pin), section y -> z
      .translate([k.at[0], k.at[1] + kh / 2 + 1, T + kd - 2.4]);
    block = block.subtract(hole);
    body = body.add(block);
  }

  const mesh = body.getMesh();
  const tv = mesh.triVerts, vp = mesh.vertProperties, np = mesh.numProp;
  const positions = new Float32Array(tv.length * 3);
  for (let i = 0; i < tv.length; i++) {
    positions[i * 3] = vp[tv[i] * np];
    positions[i * 3 + 1] = vp[tv[i] * np + 1];
    positions[i * 3 + 2] = vp[tv[i] * np + 2];
  }
  const bb = body.boundingBox();

  // validation on the REAL mesh: slice through the groove and the front lip
  const checks: GrooveCheck[] = [];
  const zg = (zGroove[0] + zGroove[1]) / 2;
  const loopsG = body.slice(zg).toPolygons();
  const loopsL = body.slice(p.frontWall / 2).toPolygons();
  for (const l of placed) {
    const pick = (loops: Vec2[][]) => {
      let best: Vec2[] | null = null, bd = Infinity;
      for (const loop of loops) {
        if (signedArea(loop as Poly) > 0) continue; // holes are clockwise
        const b = bbox(loop as Poly);
        const d = Math.hypot((b.minX + b.maxX) / 2 - l.center[0], (b.minY + b.maxY) / 2 - l.center[1]);
        if (d < bd) (bd = d), (best = loop);
      }
      return best as Poly | null;
    };
    const g = pick(loopsG as Vec2[][]), lip = pick(loopsL as Vec2[][]);
    if (!g || !lip) continue;
    const gaps = l.outline.map((pt) => signedGap(pt, g));
    const lips = l.outline.map((pt) => -signedGap(pt, lip));
    checks.push({
      eye: l.eye,
      meanGap: gaps.reduce((s, v) => s + v, 0) / gaps.length,
      minGap: Math.min(...gaps),
      maxGap: Math.max(...gaps),
      lipMean: lips.reduce((s, v) => s + v, 0) / lips.length,
      groove: g,
    });
  }

  const res: FrameResult = {
    positions,
    triangles: tv.length / 3,
    volume: body.volume(),
    genus: body.genus(),
    watertight: body.status() === 'NoError',
    openEdges: openEdgeCount(tv),
    size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]],
    thickness: T,
    grooveZ: zGroove,
    lenses: placed,
    checks,
    ms: Math.round(performance.now() - t0),
  };
  res.watertight = res.watertight && res.openEdges === 0;
  return res;
}

/** Distance from a lens point to a hole loop: + if the loop is outside the point. */
function signedGap(pt: Vec2, loop: Poly): number {
  let best = Infinity;
  for (let i = 0, n = loop.length; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const l2 = vx * vx + vy * vy;
    let t = l2 > 0 ? ((pt[0] - a[0]) * vx + (pt[1] - a[1]) * vy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(pt[0] - (a[0] + t * vx), pt[1] - (a[1] + t * vy));
    if (d < best) best = d;
  }
  return inside(pt, loop) ? best : -best;
}

function inside(pt: Vec2, poly: Poly): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Binary STL from a triangle soup. */
export function toSTL(positions: Float32Array, name = 'OptiFrame'): ArrayBuffer {
  const n = positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const head = `${name} - generated by OptiFrame`.slice(0, 80);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const p = positions.subarray(t * 9, t * 9 + 9);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l, ny /= l, nz /= l;
    dv.setFloat32(o, nx, true), dv.setFloat32(o + 4, ny, true), dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++) dv.setFloat32(o + k * 4, p[k], true);
    o += 36;
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
