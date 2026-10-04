// Photo acquisition (file / camera frame) and hand-off to the vision worker.
import { centroid, type Poly, type Vec2 } from '../core/geom.ts';
import { collectRun } from './collect.ts';
import { getState, setState, uid, type Shot } from './store.ts';
import { VisionClient } from '../vision/client.ts';
import type { Eye } from '../core/mat.ts';
import type { PipelineResult, RGBAImage } from '../vision/types.ts';

const MAX_SIDE = 4096; // 48 MP photos are downscaled: ~13 px/mm is plenty

export const vision = new VisionClient(import.meta.env.BASE_URL);
vision.onStatus = (engine) => setState({ engine });

export interface Captured {
  image: RGBAImage;
  preview: ImageBitmap;
}

export async function fromDrawable(src: CanvasImageSource, w: number, h: number): Promise<Captured> {
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const W = Math.round(w * s), H = Math.round(h * s);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H);
  const preview = await createImageBitmap(c, { resizeWidth: 1280, resizeQuality: 'high' });
  return { image: { data: id.data, width: W, height: H }, preview };
}

export async function fromBlob(blob: Blob): Promise<Captured> {
  // createImageBitmap applies the EXIF orientation by default
  const bmp = await createImageBitmap(blob);
  try {
    return await fromDrawable(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close();
  }
}

export async function fromUrl(url: string): Promise<Captured> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return fromBlob(await res.blob());
}

export type Stage = 'markers' | 'rectify' | 'segment' | 'contour';

/** Run the pipeline, store the run and save every detected lens as a shot. */
export async function analyse(c: Captured, source: Shot['source'], onStage?: (s: string) => void, forceEye: Eye | null = null): Promise<PipelineResult> {
  const st = getState();
  const { settings } = st;
  const result = await vision.process(
    c.image,
    {
      useModel: settings.useModel,
      refine: settings.refine,
      // glasses lie front face down: the visible opening is the back of the
      // rim, about one rim thickness (~3.5 mm) above the paper
      edgeHeight: settings.subject === 'glasses' ? Math.max(settings.edgeHeight, 3.5) : settings.edgeHeight,
      printScale: 1, // applied retroactively in shotLens()
      bias: 0,
      sheetFormat: settings.sheetFormat,
      forceEye,
      subject: settings.subject,
      grooveDepth: settings.grooveDepth,
      debug: true,
    },
    onStage,
  );
  const shots: Shot[] = [];
  for (const z of result.zones) {
    if (!z.contour || z.status === 'error') continue; // rejected shapes are never saved
    shots.push({
      id: uid(),
      eye: z.zone,
      time: Date.now(),
      // glasses are photographed from the back: mirror to a front view
      raw: z.backView ? mirrorAboutCentroid(z.contour) : z.contour,
      method: z.method,
      source,
      quality: result.quality,
      confidence: z.confidence,
      warnings: z.messages.map((m) => m.text),
    });
  }
  if (st.collect.on) {
    try {
      const c = await collectRun(result, st.collect.series, st.collect.reference);
      setState((s) => ({ collect: { ...s.collect, reference: c.reference, count: s.collect.count + c.stored } }));
      if (c.moved.length)
        result.warnings.push({
          code: 'MOVED',
          text: `Collecte : verre ${c.moved.join(' et ')} déplacé depuis la photo de référence.`,
          tip: 'Démarrez une nouvelle série (Aide → Collecte) avant de reprendre une référence.',
        });
    } catch (e) {
      result.warnings.push({ code: 'COLLECT', text: `Collecte impossible : ${String(e)}` });
    }
  }
  setState((s) => ({
    shots: [...s.shots, ...shots],
    last: { result, photo: c.preview, shotIds: shots.map((x) => x.id), time: Date.now(), source },
  }));
  return result;
}

function mirrorAboutCentroid(p: Poly): Poly {
  const cx = centroid(p)[0];
  return p.map(([x, y]) => [2 * cx - x, y] as Vec2).reverse();
}
