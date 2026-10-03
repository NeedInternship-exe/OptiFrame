// Tiny global store with localStorage persistence (measurements survive a reload).
import { useEffect, useState } from 'preact/hooks';
import { fuseContours, spread, type Spread } from '../core/fusion.ts';
import { centroid, mirrorX, offsetNormal, type Poly } from '../core/geom.ts';
import type { Eye } from '../core/mat.ts';
import { measureLens, type Measures } from '../core/measure.ts';
import { DEFAULT_FRAME, type FrameParams, type GrooveCheck, type PlacedLens } from '../frame/frame.ts';
import type { EngineStatus } from '../vision/client.ts';
import type { PipelineResult, Quality } from '../vision/types.ts';

export type Tab = 'measure' | 'frame' | 'validate' | 'steps' | 'help';

export interface Settings {
  useModel: boolean;
  refine: boolean;
  align: boolean;
  edgeHeight: number;
  printScale: number;
  bias: number;
}

export interface Shot {
  id: string;
  eye: Eye;
  time: number;
  raw: Poly; // final outline in mat millimetres
  method: 'ai' | 'classic';
  source: 'camera' | 'file' | 'sample';
  quality?: Quality;
  confidence?: number;
  warnings: string[];
  caliper?: { A?: number; B?: number };
}

export interface LastRun {
  result: PipelineResult;
  photo: ImageBitmap | null; // downscaled copy of the photo (step-by-step page)
  shotIds: string[];
  time: number;
  source: Shot['source'];
}

export interface FrameSummary {
  checks: GrooveCheck[];
  watertight: boolean;
  openEdges: number;
  volume: number;
  genus: number;
  triangles: number;
  size: [number, number, number];
  thickness: number;
  ms: number;
  lensSources: Record<Eye, string>;
  lenses: PlacedLens[];
}

export type Use = 'latest' | 'fusion' | string;

export interface State {
  tab: Tab;
  settings: Settings;
  shots: Shot[];
  use: Record<Eye, Use>;
  frame: FrameParams;
  frameSummary: FrameSummary | null;
  last: LastRun | null;
  engine: EngineStatus;
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: Settings = { useModel: true, refine: true, align: true, edgeHeight: 1.0, printScale: 1, bias: 0 };
const KEY = 'optiframe:v1';
const PERSIST: (keyof State)[] = ['settings', 'shots', 'use', 'frame', 'onboarded'];

function load(): State {
  const base: State = {
    tab: 'measure',
    settings: DEFAULT_SETTINGS,
    shots: [],
    use: { OD: 'latest', OS: 'latest' },
    frame: DEFAULT_FRAME,
    frameSummary: null,
    last: null,
    engine: { state: 'loading', opencv: 0, model: 0, modelReady: false },
    onboarded: false,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ...base, ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings }, frame: { ...DEFAULT_FRAME, ...saved.frame } };
    }
  } catch {
    /* private mode or corrupted storage: start fresh */
  }
  return base;
}

let state = load();
const subs = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if (PERSIST.some((k) => k in p)) {
    try {
      const out: Partial<State> = {};
      for (const k of PERSIST) (out as Record<string, unknown>)[k] = state[k];
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      /* storage full or unavailable */
    }
  }
  subs.forEach((f) => f());
}

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return state;
}

// ----------------------------------------------------------------- derived data
const cache = new Map<string, { contour: Poly; measures: Measures }>();
/**
 * Lens outline + measures of a shot. Print-scale and bias calibrations are
 * applied here (not in the pipeline) so that they also update past shots.
 */
export function shotLens(s: Shot, cfg: Pick<Settings, 'align' | 'printScale' | 'bias'> = state.settings) {
  const k = `${s.id}:${cfg.align}:${cfg.printScale}:${cfg.bias}`;
  let v = cache.get(k);
  if (!v) {
    let raw = s.raw;
    if (cfg.printScale !== 1) {
      const c = centroid(raw);
      raw = raw.map(([x, y]) => [c[0] + (x - c[0]) * cfg.printScale, c[1] + (y - c[1]) * cfg.printScale]);
    }
    if (cfg.bias) raw = offsetNormal(raw, cfg.bias);
    cache.set(k, (v = measureLens(raw, cfg.align)));
  }
  return v;
}

export interface LensChoice {
  eye: Eye;
  contour: Poly; // lens frame
  measures: Measures;
  label: string;
  shots: Shot[];
  spread: Spread | null;
  mirrored?: boolean;
}

export function lensFor(st: State, eye: Eye): LensChoice | null {
  const shots = st.shots.filter((s) => s.eye === eye).sort((a, b) => a.time - b.time);
  const cfg = st.settings;
  const sp = spread(shots.map((s) => shotLens(s, cfg).measures));
  if (!shots.length) return null;
  const use = st.use[eye];
  if (use === 'fusion' && shots.length > 1) {
    const contour = fuseContours(shots.map((s) => shotLens(s, cfg).contour));
    return { eye, contour, measures: measureLens(contour, false).measures, label: `fusion de ${shots.length} prises`, shots, spread: sp };
  }
  const pick = shots.find((s) => s.id === use) ?? shots[shots.length - 1];
  const l = shotLens(pick, cfg);
  return { eye, contour: l.contour, measures: l.measures, label: `prise de ${new Date(pick.time).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`, shots, spread: sp };
}

/** Lenses used for the frame: a missing eye mirrors the other one. */
export function framePair(st: State): { OD: LensChoice; OS: LensChoice } | null {
  const od = lensFor(st, 'OD'), os = lensFor(st, 'OS');
  if (!od && !os) return null;
  const mirror = (l: LensChoice, eye: Eye): LensChoice => ({ ...l, eye, contour: mirrorX(l.contour), label: `miroir du verre ${l.eye}`, shots: [], spread: null, mirrored: true });
  return { OD: od ?? mirror(os!, 'OD'), OS: os ?? mirror(od!, 'OS') };
}

export const uid = () => Math.random().toString(36).slice(2, 10);
