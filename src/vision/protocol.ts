import type { LiveDetection, PipelineOptions, PipelineResult, RGBAImage } from './types.ts';

export type ToWorker =
  | { type: 'init'; base: string }
  | { type: 'live'; id: number; image: RGBAImage }
  | { type: 'process'; id: number; image: RGBAImage; opts: PipelineOptions };

export type FromWorker =
  | { type: 'progress'; what: 'opencv' | 'model'; loaded: number; total: number }
  | { type: 'ready'; opencv: boolean; model: boolean; error?: string }
  | { type: 'live'; id: number; result: LiveDetection }
  | { type: 'stage'; id: number; stage: string }
  | { type: 'result'; id: number; result: PipelineResult }
  | { type: 'error'; id: number; error: string };
