import spec from '../../shared/mat.json' with { type: 'json' };
import type { Vec2 } from './geom.ts';

export type Eye = 'OD' | 'OS';

export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
  nasal: 'left' | 'right';
}

export interface MarkerSpec {
  id: number;
  x: number;
  y: number;
  corners: Vec2[];
  bits: number[][];
}

export interface MatSpec {
  version: string;
  page: { w: number; h: number };
  dictionary: string;
  markerSize: number;
  markers: MarkerSpec[];
  zones: Record<Eye, Zone>;
  ruler: { x: number; y0: number; y1: number };
}

export const MAT = spec as unknown as MatSpec;
export const MARKER_BY_ID = new Map(MAT.markers.map((m) => [m.id, m]));
export const EYES: Eye[] = ['OD', 'OS'];
export const EYE_LABEL: Record<Eye, string> = { OD: 'Verre droit (OD)', OS: 'Verre gauche (OS)' };
