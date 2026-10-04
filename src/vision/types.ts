import type { Poly, Vec2 } from '../core/geom.ts';
import type { CameraPose, Mat3 } from '../core/homography.ts';
import type { Eye } from '../core/mat.ts';

/** Model resolution (px per mm) - must match ml/dataset.py PPM. */
export const PPM_MODEL = 3;
/** Resolution of the rectified control image (px per mm). */
export const PPM_VIEW = 6;
/** Extra margin (mm) around each printed zone that is processed. */
export const ZONE_MARGIN = 4;

export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Msg {
  code: string;
  text: string;
  tip?: string;
}

export interface PipelineOptions {
  useModel: boolean;
  refine: boolean;
  /** Height (mm) of the visible lens edge above the paper, for parallax correction. */
  edgeHeight: number;
  /** Print-scale correction: real length of the 100 mm check ruler / 100. */
  printScale: number;
  /** Contour offset (mm) found by calibration against caliper readings. */
  bias: number;
  /** Blank sheet used as reference when no printed mat is found. */
  sheetFormat: 'auto' | 'letter' | 'a4';
  /** One photo per lens: the (largest) lens found is this eye, wherever it lies. */
  forceEye?: Eye | null;
  /** Loose lenses, or complete glasses laid front face down (back view). */
  subject?: 'lens' | 'glasses';
  /** Glasses: how far the lens goes into the rim groove beyond the visible opening (mm). */
  grooveDepth?: number;
  debug: boolean;
}

export const DEFAULT_OPTIONS: PipelineOptions = {
  useModel: true,
  refine: true,
  edgeHeight: 1.0,
  printScale: 1,
  bias: 0,
  sheetFormat: 'auto',
  debug: true,
};

export interface MarkerDet {
  id: number;
  corners: Vec2[]; // image pixels (TL, TR, BR, BL)
  refined: boolean;
  edgeSpreadPx: number; // 20-80 % rise distance of the marker border
}

export interface ImagePatch {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
  ppm: number; // px per mm
  x0: number; // mm of the left edge of pixel 0
  y0: number;
}

export interface ZoneResult {
  zone: Eye;
  status: 'ok' | 'warn' | 'empty' | 'error';
  messages: Msg[];
  method: 'ai' | 'classic';
  contour?: Poly; // final contour, mat millimetres (y down)
  coarse?: Poly; // contour before edge refinement
  confidence?: number;
  solidity?: number;
  backView?: boolean; // glasses photographed from the back: mirror for a front view
  refine?: { validFrac: number; meanShift: number; maxShift: number };
  view?: ImagePatch; // rectified top view (6 px/mm)
  prob?: ImagePatch; // probability map (grey) at 3 px/mm
}

export interface Quality {
  nMarkers: number;
  reprojPx: number;
  reprojMm: number;
  pxPerMm: number;
  blurMm: number;
  tiltDeg: number;
  cameraHeight: number;
}

export interface Reference {
  kind: 'mat' | 'sheet';
  label: string; // "tapis OptiFrame", "feuille Lettre", "feuille A4"
  w: number; // mm, reference page size in its photo orientation
  h: number;
  corners?: Vec2[]; // sheet corners in the photo (px)
}

export interface PipelineResult {
  ok: boolean;
  reference?: Reference;
  errors: Msg[];
  warnings: Msg[];
  image: { width: number; height: number };
  markers: MarkerDet[];
  H?: Mat3;
  pose?: CameraPose;
  quality?: Quality;
  zones: ZoneResult[];
  timings: Record<string, number>;
  modelUsed: boolean;
}

export interface LiveDetection {
  markers: { id: number; corners: Vec2[] }[]; // normalised [0,1] coordinates
  zonesVisible: Eye[];
  sheet?: Vec2[]; // blank sheet corners, normalised
  tiltDeg?: number;
}
