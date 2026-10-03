/// <reference lib="webworker" />
// Vision worker: loads OpenCV.js + the ONNX model once, then processes photos
// off the main thread so the interface stays responsive.

import * as ort from 'onnxruntime-web/wasm';
import { detectLive, processPhoto, type Engine } from './pipeline.ts';
import type { ModelRunner } from './segment.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;
/* eslint-disable @typescript-eslint/no-explicit-any */

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);
let engine: Engine | null = null;
let ready: Promise<void> | null = null;

async function fetchWithProgress(url: string, what: 'opencv' | 'model'): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (loaded - last > 256 * 1024) {
      last = loaded;
      post({ type: 'progress', what, loaded, total });
    }
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) out.set(c, o), (o += c.length);
  post({ type: 'progress', what, loaded, total: total || loaded });
  return out;
}

async function loadOpenCV(base: string): Promise<any> {
  const code = new TextDecoder().decode(await fetchWithProgress(`${base}opencv/opencv.js`, 'opencv'));
  // opencv.js is a UMD script; evaluated globally it defines self.cv
  (0, eval)(code);
  let cv = (self as any).cv;
  if (cv && typeof cv.then === 'function') {
    cv = await new Promise((resolve) => {
      cv.then((m: any) => {
        delete m.then;
        resolve(m);
      });
    });
  } else if (cv && !cv.Mat) {
    await new Promise<void>((resolve) => (cv.onRuntimeInitialized = () => resolve()));
  }
  return cv;
}

async function loadModel(base: string): Promise<ModelRunner | null> {
  try {
    // the ORT wasm binary is emitted by Vite next to the worker bundle
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const bytes = await fetchWithProgress(`${base}models/lens_seg.onnx`, 'model');
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return async (input, h, w) => {
      const out = await session.run({ image: new ort.Tensor('float32', input, [1, 3, h, w]) });
      return out.logits.data as Float32Array;
    };
  } catch (e) {
    console.warn('model unavailable', e);
    return null;
  }
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    ready ??= (async () => {
      try {
        const [cv, model] = await Promise.all([loadOpenCV(msg.base), loadModel(msg.base)]);
        engine = { cv, model };
        post({ type: 'ready', opencv: true, model: !!model });
      } catch (e) {
        post({ type: 'ready', opencv: false, model: false, error: String(e) });
      }
    })();
    return;
  }
  await ready;
  if (!engine) {
    post({ type: 'error', id: msg.id, error: 'Moteur de vision non chargé.' });
    return;
  }
  try {
    if (msg.type === 'live') {
      post({ type: 'live', id: msg.id, result: detectLive(engine.cv, msg.image) });
    } else if (msg.type === 'process') {
      const result = await processPhoto(engine, msg.image, msg.opts, (stage) => post({ type: 'stage', id: msg.id, stage }));
      const transfer: Transferable[] = [];
      for (const z of result.zones) {
        if (z.view) transfer.push(z.view.data.buffer);
        if (z.prob) transfer.push(z.prob.data.buffer);
      }
      post({ type: 'result', id: msg.id, result }, transfer);
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, error: String(e) });
  }
};
