import { useEffect, useState } from 'preact/hooks';
import { FrameTab } from './FrameTab.tsx';
import { HelpTab } from './HelpTab.tsx';
import { IconCheck, IconGlasses, IconHelp, IconCamera, IconSteps } from './icons.tsx';
import { MeasureTab } from './MeasureTab.tsx';
import { StepsTab } from './StepsTab.tsx';
import { setState, useStore, type Tab } from './store.ts';
import { ValidateTab } from './ValidateTab.tsx';

const TABS: { id: Tab; label: string; icon: (p: { size?: number }) => preact.JSX.Element }[] = [
  { id: 'measure', label: 'Mesurer', icon: IconCamera },
  { id: 'frame', label: 'Monture', icon: IconGlasses },
  { id: 'validate', label: 'Valider', icon: IconCheck },
  { id: 'steps', label: 'Pas à pas', icon: IconSteps },
  { id: 'help', label: 'Aide', icon: IconHelp },
];

function EngineChip() {
  const e = useStore().engine;
  if (e.state === 'error') return <span class="engine bad" title={e.error}>moteur indisponible</span>;
  if (e.state === 'loading') {
    const pct = Math.round(((e.opencv + e.model) / 2) * 100);
    return <span class="engine loading">chargement {pct} %</span>;
  }
  return <span class="engine ok">{e.modelReady ? 'IA prête' : 'prêt (sans IA)'}</span>;
}

function LightBox({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    document.documentElement.requestFullscreen?.().catch(() => {});
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock
      ?.request('screen')
      .then((l) => (lock = l))
      .catch(() => {});
    return () => {
      lock?.release().catch(() => {});
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);
  return (
    <div class="lightbox" onClick={onClose} role="button" aria-label="Quitter la boîte lumineuse">
      <span>Luminosité au maximum · posez le tapis sur l’écran · touchez pour quitter</span>
    </div>
  );
}

export function App() {
  const st = useStore();
  const [lightbox, setLightbox] = useState(location.hash === '#lumiere');
  useEffect(() => window.scrollTo(0, 0), [st.tab]);
  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={28} height={28} />
          <span>OptiFrame</span>
        </div>
        <EngineChip />
      </header>
      <main class="content">
        {st.tab === 'measure' && <MeasureTab />}
        {st.tab === 'frame' && <FrameTab />}
        {st.tab === 'validate' && <ValidateTab />}
        {st.tab === 'steps' && <StepsTab />}
        {st.tab === 'help' && <HelpTab onLightbox={() => setLightbox(true)} />}
      </main>
      <nav class="tabbar">
        {TABS.map((t) => (
          <button class={st.tab === t.id ? 'active' : ''} onClick={() => setState({ tab: t.id })} aria-current={st.tab === t.id ? 'page' : undefined}>
            <t.icon />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      {lightbox && <LightBox onClose={() => setLightbox(false)} />}
    </div>
  );
}
