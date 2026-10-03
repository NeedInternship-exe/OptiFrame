// Palier 4 / bonus: frame vs lens overlay, shot-to-shot consistency,
// accuracy against caliper readings, mesh checks.
import { bbox, distToPoly, pointInPoly, type Poly } from '../core/geom.ts';
import { EYE_LABEL, EYES, type Eye } from '../core/mat.ts';
import { fmt } from '../core/measure.ts';
import { toFrontView } from '../frame/frame.ts';
import { download } from '../export/svg.ts';
import { IconDownload, IconTrash } from './icons.tsx';
import { setState, shotLens, useStore, type Shot } from './store.ts';

function GrooveOverlay({ eye }: { eye: Eye }) {
  const st = useStore();
  const fs = st.frameSummary;
  const check = fs?.checks.find((c) => c.eye === eye);
  const lens = fs?.lenses.find((l) => l.eye === eye);
  if (!fs || !check || !lens) return null;
  const L = toFrontView(lens.outline), G = toFrontView(check.groove);
  const b = bbox(G);
  const pad = 3, W = b.maxX - b.minX + 2 * pad, H = b.maxY - b.minY + 2 * pad;
  // y up -> SVG y down
  const path = (p: Poly) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${(x - b.minX + pad).toFixed(2)},${(b.maxY - y + pad).toFixed(2)}`).join('') + 'Z';
  // gap around the outline (every 4th point)
  const gaps = L.filter((_, i) => i % 4 === 0).map((pt) => (pointInPoly(pt, G) ? 1 : -1) * distToPoly(pt, G));
  const gmax = 0.6;
  const chart = gaps.map((g, i) => `${i ? 'L' : 'M'}${((i / (gaps.length - 1)) * 100).toFixed(2)},${(30 - (Math.max(-0.2, Math.min(gmax, g)) / gmax) * 28).toFixed(2)}`).join('');
  const target = 30 - (st.frame.clearance / gmax) * 28;
  return (
    <div class="overlay-item">
      <h3>{EYE_LABEL[eye]}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} class="overlay-svg">
        <path d={path(G)} class="ov-groove" />
        <path d={path(L)} class="ov-lens" />
      </svg>
      <svg viewBox="0 0 100 32" class="gap-chart" preserveAspectRatio="none">
        <line x1="0" x2="100" y1={target} y2={target} class="gc-target" />
        <path d={chart} class="gc-line" />
      </svg>
      <p class="small">
        Écart verre → fond de rainure (mesuré sur le maillage) : <b>{fmt(check.meanGap, 3)} mm</b> en moyenne, de {fmt(check.minGap, 3)} à {fmt(check.maxGap, 3)} mm (consigne {fmt(st.frame.clearance, 2)} mm). Lèvre avant : {fmt(check.lipMean, 2)} mm.
      </p>
    </div>
  );
}

function ShotTable({ eye }: { eye: Eye }) {
  const st = useStore();
  const shots = st.shots.filter((s) => s.eye === eye).sort((a, b) => a.time - b.time);
  if (!shots.length) return <p class="muted small">Aucune prise pour {EYE_LABEL[eye].toLowerCase()}.</p>;
  const ms = shots.map((s) => shotLens(s, st.settings).measures);
  const mA = ms.reduce((s, m) => s + m.A, 0) / ms.length, mB = ms.reduce((s, m) => s + m.B, 0) / ms.length;
  const setCal = (s: Shot, k: 'A' | 'B', v: string) =>
    setState((x) => ({ shots: x.shots.map((y) => (y.id === s.id ? { ...y, caliper: { ...y.caliper, [k]: v === '' ? undefined : Number(v.replace(',', '.')) } } : y)) }));
  return (
    <div class="table-wrap">
      <table class="shots">
        <thead>
          <tr>
            <th>#</th>
            <th>A</th>
            <th>B</th>
            <th>ΔA</th>
            <th>ΔB</th>
            <th>A pied</th>
            <th>B pied</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shots.map((s, i) => {
            const m = ms[i];
            const eA = s.caliper?.A != null ? m.A - s.caliper.A : null, eB = s.caliper?.B != null ? m.B - s.caliper.B : null;
            return (
              <tr>
                <td>
                  {i + 1}
                  <span class={`dot ${s.method}`} title={s.method === 'ai' ? 'IA' : 'classique'} />
                </td>
                <td>{fmt(m.A, 2)}</td>
                <td>{fmt(m.B, 2)}</td>
                <td class="muted">{(m.A - mA >= 0 ? '+' : '') + fmt(m.A - mA, 2)}</td>
                <td class="muted">{(m.B - mB >= 0 ? '+' : '') + fmt(m.B - mB, 2)}</td>
                <td>
                  <input inputMode="decimal" class="cal" value={s.caliper?.A ?? ''} placeholder="mm" onChange={(e) => setCal(s, 'A', (e.target as HTMLInputElement).value)} />
                  {eA != null && <small class={Math.abs(eA) <= 1 ? 'good' : 'bad'}>{(eA >= 0 ? '+' : '') + fmt(eA, 2)}</small>}
                </td>
                <td>
                  <input inputMode="decimal" class="cal" value={s.caliper?.B ?? ''} placeholder="mm" onChange={(e) => setCal(s, 'B', (e.target as HTMLInputElement).value)} />
                  {eB != null && <small class={Math.abs(eB) <= 1 ? 'good' : 'bad'}>{(eB >= 0 ? '+' : '') + fmt(eB, 2)}</small>}
                </td>
                <td>
                  <button class="icon-btn small" aria-label="Supprimer la prise" onClick={() => setState((x) => ({ shots: x.shots.filter((y) => y.id !== s.id) }))}>
                    <IconTrash size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shots.length > 1 && (
        <p class="small">
          {shots.length} prises : écart max entre prises <b>A {fmt(Math.max(...ms.map((m) => m.A)) - Math.min(...ms.map((m) => m.A)), 2)} mm</b>, <b>B {fmt(Math.max(...ms.map((m) => m.B)) - Math.min(...ms.map((m) => m.B)), 2)} mm</b>.
        </p>
      )}
    </div>
  );
}

function exportCSV(shots: Shot[]) {
  const rows = [['eye', 'time', 'method', 'A_mm', 'B_mm', 'perimeter_mm', 'ED_mm', 'caliper_A', 'caliper_B', 'err_A', 'err_B', 'markers', 'reproj_mm', 'blur_mm', 'tilt_deg']];
  for (const s of shots) {
    const m = shotLens(s).measures;
    rows.push([
      s.eye,
      new Date(s.time).toISOString(),
      s.method,
      m.A.toFixed(3),
      m.B.toFixed(3),
      m.perimeter.toFixed(2),
      m.ed.toFixed(2),
      s.caliper?.A?.toString() ?? '',
      s.caliper?.B?.toString() ?? '',
      s.caliper?.A != null ? (m.A - s.caliper.A).toFixed(3) : '',
      s.caliper?.B != null ? (m.B - s.caliper.B).toFixed(3) : '',
      String(s.quality?.nMarkers ?? ''),
      s.quality?.reprojMm.toFixed(3) ?? '',
      s.quality?.blurMm.toFixed(3) ?? '',
      s.quality ? s.quality.tiltDeg.toFixed(1) : '',
    ]);
  }
  download('optiframe-mesures.csv', rows.map((r) => r.join(',')).join('\n'), 'text/csv');
}

export function ValidateTab() {
  const st = useStore();
  const fs = st.frameSummary;
  const withCal = st.shots.filter((s) => s.caliper?.A != null || s.caliper?.B != null);
  const errs: number[] = [];
  for (const s of withCal) {
    const m = shotLens(s, st.settings).measures;
    if (s.caliper?.A != null) errs.push(Math.abs(m.A - s.caliper.A));
    if (s.caliper?.B != null) errs.push(Math.abs(m.B - s.caliper.B));
  }
  const mae = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  return (
    <div class="tab">
      <section class="card">
        <h2>Monture ↔ verres</h2>
        <p class="muted small">Le contour mesuré (bleu) est superposé à la rainure découpée dans le maillage 3D réel (orange). Le graphique montre l’écart tout autour du verre.</p>
        {fs ? (
          <div class="overlay-grid">
            {EYES.map((e) => (
              <GrooveOverlay eye={e} />
            ))}
          </div>
        ) : (
          <button class="btn" onClick={() => setState({ tab: 'frame' })}>
            Générer la monture d’abord
          </button>
        )}
      </section>

      <section class="card">
        <h2>Cohérence entre prises et pied à coulisse</h2>
        <p class="muted small">Reprenez plusieurs photos du même verre (angle, éclairage) : ΔA et ΔB donnent l’écart à la moyenne. Saisissez les valeurs du pied à coulisse pour obtenir l’erreur réelle.</p>
        {EYES.map((e) => (
          <div>
            <h3>{EYE_LABEL[e]}</h3>
            <ShotTable eye={e} />
          </div>
        ))}
        {mae != null && (
          <div class={`msg ${mae <= 1 ? 'ok' : 'warn'}`}>
            <strong>Erreur moyenne vs pied à coulisse : {fmt(mae, 2)} mm</strong>
            <span>sur {errs.length} cotes ({withCal.length} prises)</span>
          </div>
        )}
        {st.shots.length > 0 && (
          <button class="btn" onClick={() => exportCSV(st.shots)}>
            <IconDownload /> Exporter les mesures (CSV)
          </button>
        )}
      </section>

      {fs && (
        <section class="card">
          <h2>Fichier STL</h2>
          <ul class="kv">
            <li>
              <span>Maillage fermé (étanche)</span>
              <b class={fs.watertight ? 'good' : 'bad'}>{fs.watertight ? `oui · ${fs.openEdges} arête libre` : `non · ${fs.openEdges} arêtes libres`}</b>
            </li>
            <li>
              <span>Ouvertures (genre topologique)</span>
              <b>{fs.genus}</b>
            </li>
            <li>
              <span>Dimensions</span>
              <b>
                {fmt(fs.size[0])} × {fmt(fs.size[1])} × {fmt(fs.size[2])} mm
              </b>
            </li>
            <li>
              <span>Volume · masse PLA</span>
              <b>
                {fmt(fs.volume / 1000, 2)} cm³ · {fmt((fs.volume / 1000) * 1.24, 1)} g
              </b>
            </li>
            <li>
              <span>Triangles · calcul</span>
              <b>
                {fs.triangles.toLocaleString('fr-CA')} · {fs.ms} ms
              </b>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
