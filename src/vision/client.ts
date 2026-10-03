// Main-thread wrapper around the vision worker (promise based).
import type { FromWorker, ToWorker } from './protocol.ts';
import type { LiveDetection, PipelineOptions, PipelineResult, RGBAImage } from './types.ts';

export interface EngineStatus {
  state: 'loading' | 'ready' | 'error';
  opencv: number; // 0..1 download progress
  model: number;
  modelReady: boolean;
  error?: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onStage?: (s: string) => void }; // eslint-disable-line @typescript-eslint/no-explicit-any

export class VisionClient {
  private worker: Worker;
  private seq = 1;
  private pending = new Map<number, Pending>();
  status: EngineStatus = { state: 'loading', opencv: 0, model: 0, modelReady: false };
  onStatus: (s: EngineStatus) => void = () => {};

  constructor(base: string) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(ev.data);
    this.worker.onerror = (e) => this.setStatus({ state: 'error', error: e.message || 'worker' });
    this.post({ type: 'init', base });
  }

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  private setStatus(s: Partial<EngineStatus>) {
    this.status = { ...this.status, ...s };
    this.onStatus(this.status);
  }

  private handle(m: FromWorker) {
    if (m.type === 'progress') {
      this.setStatus({ [m.what]: m.total ? m.loaded / m.total : 0 });
    } else if (m.type === 'ready') {
      this.setStatus({ state: m.opencv ? 'ready' : 'error', modelReady: m.model, opencv: 1, model: 1, error: m.error });
    } else if (m.type === 'stage') {
      this.pending.get(m.id)?.onStage?.(m.stage);
    } else {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.error));
      else p.resolve(m.result);
    }
  }

  detectLive(image: RGBAImage): Promise<LiveDetection> {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'live', id, image }, [image.data.buffer]);
    });
  }

  process(image: RGBAImage, opts: PipelineOptions, onStage?: (s: string) => void): Promise<PipelineResult> {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStage });
      this.post({ type: 'process', id, image, opts }, [image.data.buffer]);
    });
  }
}
