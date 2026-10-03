import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmt } from '../core/measure.ts';
import { download } from '../export/svg.ts';
import { IconDownload, IconSun } from './icons.tsx';
import { DEFAULT_SETTINGS, getState, setState, shotLens, useStore, type Settings } from './store.ts';

const BASE = import.meta.env.BASE_URL;
export const REPO_URL = 'https://github.com/NeedInternship-exe/OptiFrame';

function QR() {
  const ref = useRef<HTMLCanvasElement>(null);
  const url = location.origin + location.pathname;
  useEffect(() => {
    if (ref.current) QRCode.toCanvas(ref.current, url, { width: 220, margin: 1, color: { dark: '#0b1f1e', light: '#ffffff' } });
  }, [url]);
  return (
    <div class="qr">
      <canvas ref={ref} />
      <code>{url}</code>
    </div>
  );
}

function Num({ label, hint, value, step, onChange, unit = 'mm' }: { label: string; hint?: string; value: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label class="field">
      <span>{label}</span>
      <span class="field-input">
        <input type="number" inputMode="decimal" step={step} value={value} onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
        <small>{unit}</small>
      </span>
      {hint && <small class="muted">{hint}</small>}
    </label>
  );
}

export function HelpTab({ onLightbox }: { onLightbox: () => void }) {
  const st = useStore();
  const s = st.settings;
  const set = (p: Partial<Settings>) => setState({ settings: { ...s, ...p } });
  const [ruler, setRuler] = useState(String(fmt(s.printScale * 100, 1)));

  const calibrate = () => {
    const errs: number[] = [];
    for (const sh of getState().shots) {
      const m = shotLens(sh).measures;
      if (sh.caliper?.A != null) errs.push(m.A - sh.caliper.A);
      if (sh.caliper?.B != null) errs.push(m.B - sh.caliper.B);
    }
    if (!errs.length) return alert('Saisissez d’abord des valeurs au pied à coulisse dans l’onglet Valider.');
    const e = errs.reduce((a, b) => a + b, 0) / errs.length;
    // a contour offset d changes A and B by 2d
    set({ bias: Math.round((s.bias - e / 2) * 1000) / 1000 });
  };

  return (
    <div class="tab">
      <section class="card">
        <h2>Le kit de capture</h2>
        <ol class="steps-list">
          <li>
            Imprimez le <a href={`${BASE}mat/optiframe-mat-A4.pdf`} download>tapis A4 (PDF)</a> à <b>100 %</b>. Vérifiez au réglet que la règle centrale mesure 100 mm.
          </li>
          <li>Posez la feuille à plat. Idéal : sur l’écran d’un portable affichant du blanc (boîte lumineuse), ou près d’une fenêtre.</li>
          <li>Posez chaque verre face bombée vers le haut, dans sa zone : OD (droit) à gauche, OS (gauche) à droite, côté nez vers la règle.</li>
          <li>Photographiez à ~25 cm, téléphone à plat. Une photo peut mesurer les deux verres.</li>
        </ol>
        <div class="row-actions">
          <a class="btn" href={`${BASE}mat/optiframe-mat-A4.pdf`} download>
            <IconDownload /> Tapis PDF
          </a>
          <button class="btn" onClick={onLightbox}>
            <IconSun /> Boîte lumineuse
          </button>
        </div>
        <p class="muted small">« Boîte lumineuse » : ouvrez cette page sur un portable ou une tablette, posez le tapis sur l’écran blanc. Le bord du verre ressort en noir.</p>
      </section>

      <section class="card">
        <h2>Partager l’application</h2>
        <QR />
        <p class="muted small">Aucune installation, aucun compte. Fonctionne hors ligne après la première ouverture.</p>
      </section>

      <section class="card">
        <h2>Réglages et calibration</h2>
        <label class="toggle">
          <input type="checkbox" checked={s.useModel} disabled={!st.engine.modelReady} onChange={(e) => set({ useModel: (e.target as HTMLInputElement).checked })} />
          <span>Segmentation par IA {st.engine.modelReady ? '' : '(modèle non chargé)'}</span>
        </label>
        <label class="toggle">
          <input type="checkbox" checked={s.refine} onChange={(e) => set({ refine: (e.target as HTMLInputElement).checked })} />
          <span>Affinage sub-pixel sur la photo d’origine</span>
        </label>
        <label class="toggle">
          <input type="checkbox" checked={s.align} onChange={(e) => set({ align: (e.target as HTMLInputElement).checked })} />
          <span>Redresser automatiquement un verre posé de travers</span>
        </label>
        <Num label="Hauteur du bord du verre au-dessus du papier" hint="Corrige la parallaxe (le bord est vu un peu plus loin du centre de l’image)." value={s.edgeHeight} step={0.1} onChange={(v) => set({ edgeHeight: Math.max(0, Math.min(5, v)) })} />
        <label class="field">
          <span>Longueur réelle de la règle « 100 mm » du tapis imprimé</span>
          <span class="field-input">
            <input
              type="number"
              inputMode="decimal"
              step={0.1}
              value={ruler}
              onChange={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                setRuler((e.target as HTMLInputElement).value);
                if (v > 80 && v < 120) set({ printScale: v / 100 });
              }}
            />
            <small>mm</small>
          </span>
          <small class="muted">Si l’imprimante a mis à l’échelle, toutes les mesures sont corrigées (même les anciennes).</small>
        </label>
        <Num label="Biais de contour" hint="Décalage appliqué au contour, calibré sur vos verres mesurés au pied à coulisse." value={s.bias} step={0.01} onChange={(v) => set({ bias: Math.max(-1, Math.min(1, v)) })} />
        <div class="row-actions">
          <button class="btn" onClick={calibrate}>
            Calibrer le biais (pied à coulisse)
          </button>
          <button class="link-btn" onClick={() => (setRuler('100'), set(DEFAULT_SETTINGS))}>
            Réinitialiser
          </button>
        </div>
      </section>

      <section class="card">
        <h2>Données</h2>
        <p class="muted small">Tout reste sur ce téléphone : aucune photo n’est envoyée sur internet.</p>
        <div class="row-actions">
          <button class="btn" disabled={!st.shots.length} onClick={() => download('optiframe-prises.json', JSON.stringify(st.shots), 'application/json')}>
            <IconDownload /> Exporter les prises (JSON)
          </button>
          <button
            class="btn ghost danger"
            disabled={!st.shots.length}
            onClick={() => confirm('Effacer toutes les prises enregistrées ?') && setState({ shots: [], last: null, use: { OD: 'latest', OS: 'latest' } })}
          >
            Tout effacer
          </button>
        </div>
      </section>

      <section class="card">
        <h2>À propos</h2>
        <p class="small">
          OptiFrame — défi CodeML × Santé Numérique Sans Frontières. Vision : OpenCV.js (Apache 2.0). IA : U-Net entraîné sur données synthétiques, exécuté par ONNX Runtime Web (MIT). 3D : manifold-3d (Apache 2.0), three.js (MIT).
        </p>
        <p class="small">
          Code source, méthode et licences : <a href={REPO_URL}>{REPO_URL.replace('https://', '')}</a>
        </p>
        <p class="muted small">
          Moteur : OpenCV {st.engine.state === 'ready' ? '✓' : '…'} · modèle IA {st.engine.modelReady ? '✓' : '✗'}
        </p>
      </section>
    </div>
  );
}
