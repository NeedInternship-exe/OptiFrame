// "Pas à pas": the intermediate images of the last photo.
import { useEffect, useRef, useState } from 'preact/hooks';
import { EYE_LABEL } from '../core/mat.ts';
import { fmt, measureLens } from '../core/measure.ts';
import type { ZoneResult } from '../vision/types.ts';
import { drawPhoto, drawProb, patchCanvas } from './draw.ts';
import { analyse, fromUrl } from './capture.ts';
import { ControlImage, SAMPLE } from './MeasureTab.tsx';
import { setState, useStore } from './store.ts';

function Canvas({ draw, deps }: { draw: (c: HTMLCanvasElement, w: number) => void; deps: unknown[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) draw(ref.current, Math.min(720, ref.current.parentElement?.clientWidth || 640));
  }, deps);
  return <canvas ref={ref} class="control" />;
}

function RectifiedView({ z }: { z: ZoneResult }) {
  return (
    <Canvas
      deps={[z]}
      draw={(c, w) => {
        const v = z.view!;
        const src = patchCanvas(v);
        const k = w / v.width;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        c.width = w * dpr;
        c.height = v.height * k * dpr;
        c.style.aspectRatio = `${v.width} / ${v.height}`;
        const ctx = c.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(src, 0, 0, w, v.height * k);
        // 10 mm grid in mat coordinates: the scale is now known everywhere
        ctx.strokeStyle = 'rgba(14,165,233,0.35)';
        ctx.lineWidth = 1;
        const mmPx = v.ppm * k;
        for (let x = Math.ceil(v.x0 / 10) * 10; x < v.x0 + v.width / v.ppm; x += 10) {
          const px = (x - v.x0) * mmPx;
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px, v.height * k);
          ctx.stroke();
        }
        for (let y = Math.ceil(v.y0 / 10) * 10; y < v.y0 + v.height / v.ppm; y += 10) {
          const py = (y - v.y0) * mmPx;
          ctx.beginPath();
          ctx.moveTo(0, py);
          ctx.lineTo(w, py);
          ctx.stroke();
        }
      }}
    />
  );
}

export function StepsTab() {
  const st = useStore();
  const last = st.last;
  const [busy, setBusy] = useState(false);
  if (!last)
    return (
      <div class="tab">
        <section class="card">
          <h2>Pas à pas</h2>
          <p>Cette page montre, pour la dernière photo analysée, chaque étape du traitement : repères détectés, redressement, carte de l’IA, contour et mesures.</p>
          <div class="row-actions">
            <button class="btn primary" onClick={() => setState({ tab: 'measure' })}>
              Faire une mesure
            </button>
            <button
              class="btn"
              disabled={busy || st.engine.state !== 'ready'}
              onClick={async () => {
                setBusy(true);
                try {
                  await analyse(await fromUrl(SAMPLE), 'sample');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Analyse…' : 'Analyser la photo d’exemple'}
            </button>
          </div>
        </section>
      </div>
    );
  const r = last.result;
  const q = r.quality;
  const zones = r.zones.filter((z) => z.view);
  return (
    <div class="tab">
      <section class="card">
        <h2>1 · Photo et repères ArUco</h2>
        {last.photo && <Canvas deps={[last]} draw={(c, w) => drawPhoto(c, last.photo!, r.image.width, r.image.height, r.markers, w)} />}
        <p class="small">
          {r.markers.length} repères détectés sur une photo de {r.image.width} × {r.image.height} px. Chaque coin est affiné au dixième de pixel en ajustant une droite sur les 4 bords de chaque repère (vert = affiné).
        </p>
        {q && (
          <ul class="kv">
            <li>
              <span>Erreur de reprojection (homographie)</span>
              <b>
                {fmt(q.reprojPx, 2)} px = {fmt(q.reprojMm, 3)} mm
              </b>
            </li>
            <li>
              <span>Résolution sur le tapis</span>
              <b>{fmt(q.pxPerMm, 1)} px/mm</b>
            </li>
            <li>
              <span>Netteté (étalement d’un bord)</span>
              <b>{fmt(q.blurMm, 2)} mm</b>
            </li>
            <li>
              <span>Inclinaison · hauteur caméra estimée</span>
              <b>
                {Math.round(q.tiltDeg)}° · {fmt(q.cameraHeight / 10, 0)} cm
              </b>
            </li>
          </ul>
        )}
      </section>

      {zones.map((z) => (
        <>
          <section class="card">
            <h2>2 · Vue de dessus redressée — zone {z.zone}</h2>
            <RectifiedView z={z} />
            <p class="small">L’homographie ramène la zone dans le plan du tapis : 6 px/mm, grille de 10 mm. La perspective est corrigée, l’échelle est la même partout.</p>
          </section>
          {z.prob && z.contour && (
            <section class="card">
              <h2>3 · Segmentation {z.method === 'ai' ? 'par l’IA' : 'classique'}</h2>
              <Canvas deps={[z]} draw={(c, w) => drawProb(c, z.prob!, z.contour!, w)} />
              <p class="small">
                {z.method === 'ai'
                  ? 'Probabilité « verre » donnée par le réseau U-Net (3 px/mm), entraîné sur des images synthétiques avec reflets, ombres et bords peu contrastés.'
                  : 'Seuillage de l’assombrissement + bords de Canny, puis remplissage de la région fermée.'}{' '}
                Confiance au bord : {fmt((z.confidence ?? 0) * 100, 0)} %.
              </p>
            </section>
          )}
          {z.contour && (
            <section class="card">
              <h2>4 · Contour affiné et mesures — {EYE_LABEL[z.zone]}</h2>
              <ControlImage zone={z} raw={z.contour} coarse />
              <p class="small">
                Orange pointillé : contour issu de la carte de probabilité. Vert : contour recalé sur le bord du verre dans la photo d’origine (pleine résolution, le long des normales).
                {z.refine && ` ${fmt(z.refine.validFrac * 100, 0)} % des points recalés, déplacement moyen ${fmt(z.refine.meanShift, 2)} mm.`}
              </p>
              {(() => {
                const m = measureLens(z.contour, st.settings.align).measures;
                return (
                  <ul class="kv">
                    <li>
                      <span>A × B (boxing)</span>
                      <b>
                        {fmt(m.A, 2)} × {fmt(m.B, 2)} mm
                      </b>
                    </li>
                    <li>
                      <span>Périmètre · diamètre effectif</span>
                      <b>
                        {fmt(m.perimeter, 1)} · {fmt(m.ed, 1)} mm
                      </b>
                    </li>
                    <li>
                      <span>Rotation corrigée</span>
                      <b>{fmt(m.angle, 1)}°</b>
                    </li>
                  </ul>
                );
              })()}
            </section>
          )}
        </>
      ))}

      <section class="card">
        <h2>Temps de calcul</h2>
        <ul class="kv">
          {Object.entries(r.timings).map(([k, v]) => (
            <li>
              <span>{k}</span>
              <b>{v} ms</b>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
