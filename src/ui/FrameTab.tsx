import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Poly } from '../core/geom.ts';
import { EYE_LABEL, EYES, type Eye } from '../core/mat.ts';
import { fmt, measureLens } from '../core/measure.ts';
import { buildFrameAsync } from '../frame/client.ts';
import { DEFAULT_FRAME, toSTL, type FrameParams, type FrameResult } from '../frame/frame.ts';
import { download } from '../export/svg.ts';
import { IconDownload } from './icons.tsx';
import { framePair, setState, useStore, type LensChoice } from './store.ts';
import { Viewer3D } from './Viewer3D.tsx';

function superellipse(A: number, B: number, p: number, n = 360): Poly {
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n, c = Math.cos(t), s = Math.sin(t);
    const r = (Math.abs(c / (A / 2)) ** p + Math.abs(s / (B / 2)) ** p) ** (-1 / p);
    out.push([r * c, r * s]);
  }
  return out;
}

/** Demo pair when nothing was measured yet (the 50 x 36 mm ellipses of the brief + a different shape). */
function demoPair(): Record<Eye, LensChoice> {
  const mk = (eye: Eye, c: Poly, label: string): LensChoice => ({ eye, contour: c, measures: measureLens(c, false).measures, label, shots: [], spread: null });
  return { OD: mk('OD', superellipse(50, 36, 2), 'démo : ellipse 50 × 36'), OS: mk('OS', superellipse(52, 34, 3.6), 'démo : rectangle arrondi 52 × 34') };
}

interface SliderProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}
function Slider({ label, hint, value, min, max, step, unit = 'mm', onChange }: SliderProps) {
  return (
    <label class="slider">
      <span class="slider-head">
        <span>{label}</span>
        <b>
          {value.toFixed(step < 0.1 ? 2 : 1)} {unit}
        </b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
      {hint && <small class="muted">{hint}</small>}
    </label>
  );
}

export function FrameTab() {
  const st = useStore();
  const p = st.frame;
  const measured = framePair(st);
  const pair = measured ?? demoPair();
  const [res, setRes] = useState<FrameResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hash = (c: Poly) => c.reduce((s, [x, y], i) => s + x * ((i % 7) + 1) + y * ((i % 5) + 1), 0).toFixed(4);
  const key = useMemo(() => JSON.stringify([hash(pair.OD.contour), hash(pair.OS.contour), p]), [pair.OD, pair.OS, p]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await buildFrameAsync(
          EYES.map((e) => ({ eye: e, contour: pair[e].contour })),
          p,
        );
        if (!alive) return;
        setRes(r);
        setErr(null);
        setState({
          frameSummary: {
            checks: r.checks,
            watertight: r.watertight,
            openEdges: r.openEdges,
            volume: r.volume,
            genus: r.genus,
            triangles: r.triangles,
            size: r.size,
            thickness: r.thickness,
            ms: r.ms,
            lensSources: { OD: pair.OD.label, OS: pair.OS.label },
            lenses: r.lenses,
          },
        });
      } catch (e) {
        if (alive && String(e) !== 'Error: superseded') setErr(String(e));
      } finally {
        if (alive) setBusy(false);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);

  const set = (patch: Partial<FrameParams>) => setState({ frame: { ...p, ...patch } });

  return (
    <div class="tab">
      {!measured && (
        <div class="msg warn">
          <strong>Aucun verre mesuré : formes de démonstration.</strong>
          <span>Mesurez vos verres dans l’onglet Mesurer pour générer votre monture.</span>
        </div>
      )}
      <section class="card">
        <div class="card-head">
          <h2>Monture sur mesure</h2>
          <span class={`muted small ${busy ? 'pulse' : ''}`}>{busy ? 'calcul…' : res ? `${res.ms} ms` : ''}</span>
        </div>
        <Viewer3D frame={res} edgeThickness={p.edgeThickness} />
        {err && <div class="msg error"><strong>Génération impossible</strong><span>{err}</span></div>}
        {res && (
          <div class="chips">
            <span class={`chip ${res.watertight ? 'good' : 'bad'}`}>{res.watertight ? '✓ maillage fermé' : '✗ maillage ouvert'}</span>
            <span class="chip">
              {fmt(res.size[0], 0)} × {fmt(res.size[1], 0)} × {fmt(res.thickness, 1)} mm
            </span>
            <span class="chip">≈ {fmt((res.volume / 1000) * 1.24, 1)} g de PLA</span>
            <span class="chip">{res.triangles.toLocaleString('fr-CA')} triangles</span>
          </div>
        )}
        <button class="btn primary big" disabled={!res || busy} onClick={() => res && download('monture.stl', toSTL(res.positions, 'monture'), 'model/stl')}>
          <IconDownload /> Télécharger monture.stl
        </button>
        <p class="muted small">Imprimer face avant sur le plateau, sans supports (rainure à 45°). Charnière : un bout de filament 1,75 mm sert d’axe.</p>
      </section>

      <section class="card">
        <h2>Verres utilisés</h2>
        {EYES.map((e) => {
          const l = pair[e];
          const shots = st.shots.filter((s) => s.eye === e);
          return (
            <div class="lens-source">
              <div>
                <b>{EYE_LABEL[e]}</b>
                <div class="muted small">
                  A {fmt(l.measures.A)} × B {fmt(l.measures.B)} mm · {l.label}
                </div>
              </div>
              {shots.length > 0 && (
                <select value={st.use[e]} onChange={(ev) => setState({ use: { ...st.use, [e]: (ev.target as HTMLSelectElement).value } })}>
                  <option value="latest">dernière prise</option>
                  {shots.length > 1 && <option value="fusion">fusion des {shots.length} prises</option>}
                  {shots.map((s, i) => (
                    <option value={s.id}>
                      prise {i + 1} ({new Date(s.time).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })})
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </section>

      <section class="card">
        <h2>Paramètres</h2>
        <Slider label="Pont (distance entre verres)" value={p.bridge} min={12} max={26} step={0.5} onChange={(v) => set({ bridge: v })} hint="18 mm par défaut (norme ISO 8624 : DBL)" />
        <Slider label="Largeur du cercle" value={p.rimWidth} min={2.5} max={7} step={0.25} onChange={(v) => set({ rimWidth: v })} />
        <Slider label="Jeu verre / rainure" value={p.clearance} min={0} max={0.5} step={0.05} onChange={(v) => set({ clearance: v })} hint="0,1 à 0,3 mm conseillé : le verre est légèrement bombé" />
        <Slider label="Épaisseur du bord du verre" value={p.edgeThickness} min={1} max={5} step={0.1} onChange={(v) => set({ edgeThickness: v })} hint="Mesurée au pied à coulisse sur la tranche du verre" />
        <Slider label="Lèvre avant (retient le verre)" value={p.lipFront} min={0.4} max={1.5} step={0.1} onChange={(v) => set({ lipFront: v })} />
        <Slider label="Lèvre arrière (clipsage)" value={p.lipBack} min={0.2} max={1} step={0.05} onChange={(v) => set({ lipBack: v })} hint="Plus petite = clipsage plus facile" />
        <label class="toggle">
          <input type="checkbox" checked={p.hinges} onChange={(e) => set({ hinges: (e.target as HTMLInputElement).checked })} />
          <span>Tenons de branches avec charnière</span>
        </label>
        <button class="link-btn" onClick={() => setState({ frame: DEFAULT_FRAME })}>
          Valeurs par défaut
        </button>
      </section>
    </div>
  );
}
