import { useEffect, useRef, useState } from 'preact/hooks';
import { EYE_LABEL, EYES, type Eye } from '../core/mat.ts';
import { fmt, measureLens } from '../core/measure.ts';
import { contoursSVG, download } from '../export/svg.ts';
import type { Msg, ZoneResult } from '../vision/types.ts';
import { Camera } from './Camera.tsx';
import { analyse, fromBlob, fromUrl, type Captured } from './capture.ts';
import { drawControl, outlinePath } from './draw.ts';
import { IconCamera, IconDownload, IconImage, IconSpark, IconTrash } from './icons.tsx';
import { getState, lensFor, setState, useStore, type LastRun } from './store.ts';

const STAGES: [string, string][] = [
  ['markers', 'Repères du tapis'],
  ['rectify', 'Redressement vue de dessus'],
  ['segment', 'Segmentation du verre (IA)'],
  ['contour', 'Contour et mesures'],
];

export const SAMPLE = `${import.meta.env.BASE_URL}samples/exemple-paire.jpg`;

export function MessageBox({ m, kind }: { m: Msg; kind: 'error' | 'warn' }) {
  return (
    <div class={`msg ${kind}`}>
      <strong>{m.text}</strong>
      {m.tip && <span>{m.tip}</span>}
    </div>
  );
}

export function ControlImage({ zone, raw, coarse }: { zone: ZoneResult; raw: ZoneResult['contour']; coarse?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const align = useStore().settings.align;
  useEffect(() => {
    if (!ref.current || !zone.view || !raw) return;
    drawControl(ref.current, zone.view, raw, measureLens(raw, align).measures, coarse ? zone.coarse : undefined, Math.min(640, ref.current.parentElement?.clientWidth || 640));
  }, [zone, raw, align, coarse]);
  return <canvas ref={ref} class="control" />;
}

function LensCard({ eye }: { eye: Eye }) {
  const st = useStore();
  const l = lensFor(st, eye);
  if (!l)
    return (
      <div class="lens-card empty">
        <div class="lens-eye">{EYE_LABEL[eye]}</div>
        <div class="lens-thumb placeholder">
          <span>à mesurer</span>
        </div>
        <div class="lens-dims muted">Posez le verre dans la zone {eye} du tapis</div>
      </div>
    );
  const t = outlinePath(l.contour, 120);
  const m = l.measures;
  return (
    <div class="lens-card">
      <div class="lens-eye">{EYE_LABEL[eye]}</div>
      <svg class="lens-thumb" viewBox={`0 0 ${t.w} ${t.h}`} aria-hidden="true">
        <path d={t.d} />
      </svg>
      <div class="lens-dims">
        <b>{fmt(m.A)}</b> × <b>{fmt(m.B)}</b> mm
      </div>
      <div class="lens-sub">
        périmètre {fmt(m.perimeter)} mm · {l.shots.length} prise{l.shots.length > 1 ? 's' : ''}
        {l.spread && l.spread.n > 1 ? ` · écart ±${fmt(Math.max(l.spread.rangeA, l.spread.rangeB) / 2, 2)}` : ''}
      </div>
    </div>
  );
}

function RunResult({ last }: { last: LastRun }) {
  const st = useStore();
  const r = last.result;
  const saved = new Set(last.shotIds);
  const shots = st.shots.filter((s) => saved.has(s.id));
  const reassign = (id: string) => setState((s) => ({ shots: s.shots.map((x) => (x.id === id ? { ...x, eye: x.eye === 'OD' ? 'OS' : 'OD' } : x)) }));
  const remove = (id: string) => setState((s) => ({ shots: s.shots.filter((x) => x.id !== id) }));
  return (
    <section class="card">
      <div class="card-head">
        <h2>{r.ok ? 'Résultat' : 'Mesure impossible'}</h2>
        <span class="muted small">{(r.timings.total / 1000).toFixed(1)} s</span>
      </div>
      {r.errors.map((m) => (
        <MessageBox m={m} kind="error" />
      ))}
      {r.warnings.map((m) => (
        <MessageBox m={m} kind="warn" />
      ))}
      {r.quality && (
        <div class="chips">
          <span class="chip">{r.quality.nMarkers}/8 repères</span>
          <span class="chip">reprojection {fmt(r.quality.reprojMm, 2)} mm</span>
          <span class="chip">netteté {fmt(r.quality.blurMm, 2)} mm</span>
          <span class="chip">inclinaison {Math.round(r.quality.tiltDeg)}°</span>
          <span class="chip">{fmt(r.quality.pxPerMm, 1)} px/mm</span>
        </div>
      )}
      {r.zones
        .filter((z) => z.contour)
        .map((z) => {
          const shot = shots.find((s) => s.raw === z.contour) ?? shots.find((s) => s.eye === z.zone);
          const m = measureLens(z.contour!, st.settings.align).measures;
          return (
            <div class="zone-result">
              <div class="zone-head">
                <h3>{EYE_LABEL[shot?.eye ?? z.zone]}</h3>
                <span class={`badge ${z.method}`}>{z.method === 'ai' ? 'IA' : 'classique'}</span>
              </div>
              <ControlImage zone={z} raw={z.contour} />
              <div class="measures">
                <div>
                  <span>A</span>
                  <b>{fmt(m.A, 1)}</b>
                  <small>mm</small>
                </div>
                <div>
                  <span>B</span>
                  <b>{fmt(m.B, 1)}</b>
                  <small>mm</small>
                </div>
                <div>
                  <span>Périmètre</span>
                  <b>{fmt(m.perimeter, 1)}</b>
                  <small>mm</small>
                </div>
                <div>
                  <span>ED</span>
                  <b>{fmt(m.ed, 1)}</b>
                  <small>mm</small>
                </div>
              </div>
              {z.messages.map((mm) => (
                <MessageBox m={mm} kind="warn" />
              ))}
              {shot && (
                <div class="row-actions">
                  <button class="btn ghost small" onClick={() => reassign(shot.id)}>
                    ⇄ C’est le verre {shot.eye === 'OD' ? 'gauche (OS)' : 'droit (OD)'}
                  </button>
                  <button class="btn ghost small danger" onClick={() => remove(shot.id)}>
                    <IconTrash size={16} /> Supprimer
                  </button>
                </div>
              )}
            </div>
          );
        })}
      {r.zones.some((z) => z.contour) && (
        <button class="btn ghost" onClick={() => setState({ tab: 'steps' })}>
          Voir le pas à pas (images intermédiaires)
        </button>
      )}
    </section>
  );
}

export function exportSVG() {
  const st = getState();
  const lenses = EYES.map((e) => lensFor(st, e)).filter((l): l is NonNullable<typeof l> => !!l);
  if (!lenses.length) return;
  download('contours-1-1.svg', contoursSVG(lenses.map((l) => ({ eye: l.eye, contour: l.contour, measures: l.measures, label: l.label }))), 'image/svg+xml');
}

export function MeasureTab() {
  const st = useStore();
  const [camera, setCamera] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const run = async (get: () => Promise<Captured>, source: 'camera' | 'file' | 'sample') => {
    setErr(null);
    setStage('load');
    try {
      const c = await get();
      setStage('markers');
      await analyse(c, source, setStage);
      setState({ onboarded: true });
    } catch (e) {
      setErr(`Le traitement a échoué : ${String(e)}`);
    } finally {
      setStage(null);
    }
  };

  const onFile = (ev: Event) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    setCamera(false);
    if (f) run(() => fromBlob(f), 'file');
  };

  const engine = st.engine;
  const hasLens = st.shots.length > 0;
  return (
    <div class="tab">
      {!st.onboarded && (
        <section class="card intro">
          <h2>Mesurer un verre en 3 étapes</h2>
          <ol class="steps-list">
            <li>
              <b>Imprimez le tapis</b> à 100 % (taille réelle) et posez-le à plat. <a href={`${import.meta.env.BASE_URL}mat/optiframe-mat-A4.pdf`} download>Télécharger le PDF</a>
            </li>
            <li>
              <b>Posez le verre</b> face bombée vers le haut dans la zone OD (verre droit) ou OS (verre gauche). Astuce : feuille sur l’écran blanc d’un portable = boîte lumineuse.
            </li>
            <li>
              <b>Photographiez</b> téléphone à plat, à ~25 cm : les carrés noirs doivent être visibles.
            </li>
          </ol>
          <button class="btn ghost" onClick={() => run(() => fromUrl(SAMPLE), 'sample')} disabled={engine.state !== 'ready' || !!stage}>
            <IconSpark /> Pas de tapis ? Essayer avec une photo d’exemple
          </button>
        </section>
      )}

      <div class="lens-grid">
        {EYES.map((e) => (
          <LensCard eye={e} key={e} />
        ))}
      </div>

      <div class="capture-bar">
        <button class="btn primary big" onClick={() => setCamera(true)} disabled={!!stage}>
          <IconCamera /> Photographier
        </button>
        <button class="btn" onClick={() => file.current?.click()} disabled={!!stage}>
          <IconImage /> Importer
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={onFile} />
      </div>
      {st.onboarded && (
        <button class="link-btn" onClick={() => run(() => fromUrl(SAMPLE), 'sample')} disabled={engine.state !== 'ready' || !!stage}>
          Essayer avec la photo d’exemple
        </button>
      )}

      {stage && (
        <section class="card processing">
          <h2>Analyse en cours…</h2>
          {engine.state !== 'ready' && <p class="muted">Chargement du moteur de vision ({Math.round(engine.opencv * 100)} %)…</p>}
          <ul class="stage-list">
            {STAGES.map(([k, label], i) => {
              const cur = STAGES.findIndex(([kk]) => kk === stage);
              return <li class={i < cur ? 'done' : i === cur ? 'active' : ''}>{label}</li>;
            })}
          </ul>
        </section>
      )}
      {err && <MessageBox m={{ code: 'ERR', text: err }} kind="error" />}
      {!stage && st.last && <RunResult last={st.last} />}

      {hasLens && (
        <div class="row-actions center">
          <button class="btn" onClick={exportSVG}>
            <IconDownload /> Contours SVG 1:1
          </button>
          <button class="btn primary" onClick={() => setState({ tab: 'frame' })}>
            Créer la monture →
          </button>
        </div>
      )}

      {camera && (
        <Camera
          onClose={() => setCamera(false)}
          onFile={() => file.current?.click()}
          onCapture={(c) => {
            setCamera(false);
            run(async () => c, 'camera');
          }}
        />
      )}
    </div>
  );
}
