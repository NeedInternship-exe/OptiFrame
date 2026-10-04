import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmt } from '../core/measure.ts';
import { download } from '../export/svg.ts';
import { IconDownload, IconSun } from './icons.tsx';
import { allSamples, clearSamples } from './collect.ts';
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
        <h2>Prendre la photo</h2>
        <h3>Option 1 · une feuille blanche (rien à imprimer)</h3>
        <ol class="steps-list">
          <li>Une feuille blanche Lettre ou A4, bien à plat, sur une table <b>plus foncée</b> que le papier.</li>
          <li>Les verres face bombée vers le haut, à plus de 1 cm des bords. Deux verres : le droit (OD) à gauche, le gauche (OS) à droite.</li>
          <li>Photo téléphone tenu droit (le haut des verres en haut de l’écran), à ~30 cm, les 4 coins de la feuille visibles.</li>
        </ol>
        <h3>Option 2 · le tapis imprimé (plus précis)</h3>
        <ol class="steps-list">
          <li>
            Imprimer à <b>100 %</b> : <a href={`${BASE}mat/optiframe-mat-lettre.pdf`} download>tapis Lettre</a> ou <a href={`${BASE}mat/optiframe-mat-A4.pdf`} download>tapis A4</a>. Vérifier au réglet que la règle centrale mesure 100 mm.
          </li>
          <li>Idéal : poser la feuille sur l’écran d’un portable affichant du blanc (boîte lumineuse) : le bord du verre ressort en noir.</li>
          <li>Verre droit (OD) dans la zone de gauche, verre gauche (OS) dans celle de droite, côté nez vers la règle.</li>
        </ol>
        <div class="row-actions">
          <a class="btn" href={`${BASE}mat/optiframe-mat-lettre.pdf`} download>
            <IconDownload /> Tapis Lettre
          </a>
          <a class="btn" href={`${BASE}mat/optiframe-mat-A4.pdf`} download>
            <IconDownload /> Tapis A4
          </a>
          <button class="btn" onClick={onLightbox}>
            <IconSun /> Boîte lumineuse
          </button>
        </div>
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
        <label class="field">
          <span>Format de la feuille blanche</span>
          <select value={s.sheetFormat} onChange={(e) => set({ sheetFormat: (e.target as HTMLSelectElement).value as Settings['sheetFormat'] })}>
            <option value="auto">Automatique (Lettre ou A4)</option>
            <option value="letter">Lettre (216 × 279 mm)</option>
            <option value="a4">A4 (210 × 297 mm)</option>
          </select>
        </label>
        <Num label="Lunettes montées : profondeur de la rainure" hint="Partie du verre cachée dans le cercle, ajoutée à l’ouverture mesurée (0,3 à 1 mm selon la monture)." value={s.grooveDepth} step={0.1} onChange={(v) => set({ grooveDepth: Math.max(0, Math.min(2, v)) })} />
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
        <h2>Collecte de données réelles (capture appariée)</h2>
        <p class="small">
          Pour entraîner l’IA sur de vraies photos sans rien annoter : <b>1.</b> photo de référence des verres sur la boîte lumineuse (bord net) ; <b>2.</b> sans bouger les verres, autres photos en conditions difficiles (lumière de la pièce,
          reflets, autre angle). Le contour de référence sert d’étiquette exacte pour ces photos, car toutes sont redressées en millimètres du tapis.
        </p>
        <label class="toggle">
          <input type="checkbox" checked={st.collect.on} onChange={(e) => setState({ collect: { ...st.collect, on: (e.target as HTMLInputElement).checked } })} />
          <span>Mode collecte</span>
        </label>
        {st.collect.on && (
          <p class="muted small">
            Série <b>{st.collect.series}</b> · référence OD {st.collect.reference.OD ? '✓' : '—'} · OS {st.collect.reference.OS ? '✓' : '—'} · {st.collect.count} image{st.collect.count > 1 ? 's' : ''} enregistrée{st.collect.count > 1 ? 's' : ''}
            {!st.collect.reference.OD && !st.collect.reference.OS && ' — la prochaine photo sera la référence (boîte lumineuse).'}
          </p>
        )}
        <div class="row-actions">
          <button
            class="btn"
            disabled={!st.collect.on}
            onClick={() => setState({ collect: { ...st.collect, series: `s${Number(st.collect.series.slice(1) || 0) + 1}`, reference: {} } })}
          >
            Nouvelle série (verres déplacés)
          </button>
          <button
            class="btn"
            disabled={!st.collect.count}
            onClick={async () => download('optiframe-collecte.json', JSON.stringify({ version: 1, samples: await allSamples() }), 'application/json')}
          >
            <IconDownload /> Exporter le jeu (JSON)
          </button>
          <button
            class="btn ghost danger"
            disabled={!st.collect.count}
            onClick={async () => {
              if (!confirm('Effacer les images collectées ?')) return;
              await clearSamples();
              setState({ collect: { ...st.collect, count: 0, reference: {} } });
            }}
          >
            Effacer
          </button>
        </div>
        <p class="muted small">Conversion pour l’entraînement : <code>ml/import_real.py</code> (voir ml/README.md).</p>
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
