/// <reference lib="webworker" />
// CAD runs off the main thread: the 3D preview and sliders stay smooth.
import { buildFrame, type FrameParams, type FrameResult, type LensInput } from './frame.ts';

declare const self: DedicatedWorkerGlobalScope;

export type FrameRequest = { id: number; lenses: LensInput[]; params: FrameParams };
export type FrameReply = { id: number; result?: FrameResult; error?: string };

self.onmessage = async (ev: MessageEvent<FrameRequest>) => {
  const { id, lenses, params } = ev.data;
  try {
    const result = await buildFrame(lenses, params);
    self.postMessage({ id, result } satisfies FrameReply, [result.positions.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e) } satisfies FrameReply);
  }
};
