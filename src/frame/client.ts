import type { FrameParams, FrameResult, LensInput } from './frame.ts';
import type { FrameReply } from './frame.worker.ts';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: FrameReply) => void>();

/** Build the frame in a worker. Only the latest request is resolved with a result. */
export function buildFrameAsync(lenses: LensInput[], params: FrameParams): Promise<FrameResult> {
  if (!worker) {
    worker = new Worker(new URL('./frame.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<FrameReply>) => {
      pending.get(ev.data.id)?.(ev.data);
      pending.delete(ev.data.id);
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (r) => {
      if (id !== seq) reject(new Error('superseded'));
      else if (r.error || !r.result) reject(new Error(r.error ?? 'frame'));
      else resolve(r.result);
    });
    worker!.postMessage({ id, lenses, params });
  });
}
