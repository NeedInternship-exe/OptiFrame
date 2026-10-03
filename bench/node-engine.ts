// Load the same engines as the browser worker, but in Node:
// OpenCV.js (UMD) and ONNX Runtime Web (wasm backend).
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import type { Engine } from '../src/vision/pipeline.ts';
import type { ModelRunner } from '../src/vision/segment.ts';
import type { RGBAImage } from '../src/vision/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadEngine(useModel: boolean, modelPath = `${ROOT}public/models/lens_seg.onnx`): Promise<Engine> {
  // package.json has "type": "module", so a plain require() would load
  // opencv.js as strict ESM and break it: evaluate it as a CommonJS script.
  const path = `${ROOT}public/opencv/opencv.js`;
  const mod = { exports: {} as any };
  new Function('module', 'exports', 'require', '__filename', '__dirname', readFileSync(path, 'utf8'))(mod, mod.exports, require, path, `${ROOT}public/opencv`);
  let cv: any = mod.exports;
  if (typeof cv.then === 'function') {
    cv = await new Promise((r) =>
      cv.then((m: any) => {
        delete m.then;
        r(m);
      }),
    );
  }
  let model: ModelRunner | null = null;
  if (useModel && existsSync(modelPath)) {
    const ort: any = await import(`${ROOT}node_modules/onnxruntime-web/dist/ort.wasm.min.mjs`);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = `${ROOT}node_modules/onnxruntime-web/dist/`;
    const session = await ort.InferenceSession.create(readFileSync(modelPath), { executionProviders: ['wasm'] });
    model = async (input, h, w) => (await session.run({ image: new ort.Tensor('float32', input, [1, 3, h, w]) })).logits.data;
  }
  return { cv, model };
}

export function readJpeg(path: string): RGBAImage {
  const d = jpeg.decode(readFileSync(path), { useTArray: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200 });
  return { data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), width: d.width, height: d.height };
}
