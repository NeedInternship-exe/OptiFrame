// Full-screen camera with live marker detection and guidance.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LiveDetection } from '../vision/types.ts';
import { fromBlob, fromDrawable, vision, type Captured } from './capture.ts';
import { IconClose, IconFlash, IconImage } from './icons.tsx';
import { useStore } from './store.ts';

interface Props {
  onCapture: (c: Captured) => void;
  onClose: () => void;
  onFile: () => void;
}

function guidance(d: LiveDetection | null, engineReady: boolean): { text: string; ok: boolean } {
  if (!engineReady) return { text: 'Chargement du moteur de vision…', ok: false };
  if (!d) return { text: 'Cadrez le tapis OptiFrame', ok: false };
  const n = d.markers.length;
  if (n === 0) return { text: 'Cadrez le tapis : les carrés noirs doivent être visibles', ok: false };
  if (n < 3) return { text: `${n} repère${n > 1 ? 's' : ''} sur 3 minimum — reculez un peu`, ok: false };
  if (!d.zonesVisible.length) return { text: 'Cadrez une zone de verre en entier', ok: false };
  if ((d.tiltDeg ?? 0) > 35) return { text: 'Tenez le téléphone plus à plat', ok: false };
  const z = d.zonesVisible.join(' + ');
  return { text: `Prêt · ${n} repères · zone ${z}`, ok: true };
}

export function Camera({ onCapture, onClose, onFile }: Props) {
  const st = useStore();
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [det, setDet] = useState<LiveDetection | null>(null);
  const [busy, setBusy] = useState(false);
  const [torch, setTorch] = useState<boolean | null>(null);

  useEffect(() => {
    let s: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
        });
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        setStream(s);
        const v = video.current!;
        v.srcObject = s;
        await v.play().catch(() => {});
        const caps = s.getVideoTracks()[0].getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
        if (caps?.torch) setTorch(false);
      } catch (e) {
        const name = (e as Error).name;
        setError(
          name === 'NotAllowedError'
            ? 'L’accès à la caméra a été refusé. Autorisez-le dans le navigateur, ou importez une photo.'
            : 'Caméra indisponible sur cet appareil. Importez une photo prise avec l’appareil photo.',
        );
      }
    })();
    return () => {
      cancelled = true;
      s?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // live detection loop (one request in flight at a time)
  useEffect(() => {
    if (!stream) return;
    let alive = true;
    const small = document.createElement('canvas');
    const tick = async () => {
      const v = video.current;
      if (!alive) return;
      if (v && v.videoWidth && st.engine.state === 'ready') {
        const w = 640, h = Math.round((640 * v.videoHeight) / v.videoWidth);
        small.width = w;
        small.height = h;
        const ctx = small.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(v, 0, 0, w, h);
        const id = ctx.getImageData(0, 0, w, h);
        try {
          const d = await vision.detectLive({ data: id.data, width: w, height: h });
          if (alive) setDet(d);
        } catch {
          /* ignore a dropped frame */
        }
      }
      if (alive) setTimeout(tick, 250);
    };
    tick();
    return () => {
      alive = false;
    };
  }, [stream, st.engine.state]);

  // overlay drawing (object-fit: cover mapping)
  useEffect(() => {
    const c = overlay.current, v = video.current;
    if (!c || !v || !v.videoWidth) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr;
    c.height = r.height * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    if (!det) return;
    const s = Math.max(r.width / v.videoWidth, r.height / v.videoHeight);
    const ox = (r.width - v.videoWidth * s) / 2, oy = (r.height - v.videoHeight * s) / 2;
    const ok = guidance(det, true).ok;
    for (const m of det.markers) {
      ctx.beginPath();
      m.corners.forEach(([x, y], i) => {
        const px = ox + x * v.videoWidth * s, py = oy + y * v.videoHeight * s;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.closePath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = ok ? '#22c55e' : '#facc15';
      ctx.stroke();
    }
  }, [det]);

  const shoot = async () => {
    const v = video.current;
    if (!v || !stream || busy) return;
    setBusy(true);
    try {
      const track = stream.getVideoTracks()[0];
      // full sensor resolution where the browser supports it (Chrome Android)
      const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> } }).ImageCapture;
      let cap: Captured | null = null;
      if (IC) {
        try {
          cap = await fromBlob(await new IC(track).takePhoto());
        } catch {
          cap = null;
        }
      }
      cap ??= await fromDrawable(v, v.videoWidth, v.videoHeight);
      onCapture(cap);
    } catch (e) {
      setError(`Capture impossible : ${String(e)}`);
      setBusy(false);
    }
  };

  const toggleTorch = async () => {
    if (!stream || torch === null) return;
    const t = !torch;
    await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: t } as MediaTrackConstraintSet] }).catch(() => {});
    setTorch(t);
  };

  const g = guidance(det, st.engine.state === 'ready');
  return (
    <div class="camera" role="dialog" aria-label="Appareil photo">
      <video ref={video} playsInline muted autoPlay />
      <canvas ref={overlay} class="camera-overlay" />
      <div class="camera-top">
        <button class="icon-btn dark" onClick={onClose} aria-label="Fermer">
          <IconClose />
        </button>
        <div class={`guide ${g.ok ? 'ok' : ''}`}>{g.text}</div>
        {torch !== null ? (
          <button class={`icon-btn dark ${torch ? 'on' : ''}`} onClick={toggleTorch} aria-label="Lampe">
            <IconFlash />
          </button>
        ) : (
          <span style={{ width: 44 }} />
        )}
      </div>
      {error && (
        <div class="camera-error">
          <p>{error}</p>
          <button class="btn primary" onClick={onFile}>
            <IconImage /> Importer une photo
          </button>
        </div>
      )}
      <div class="camera-bottom">
        <button class="icon-btn dark" onClick={onFile} aria-label="Importer une photo">
          <IconImage />
        </button>
        <button class={`shutter ${g.ok ? 'ready' : ''}`} onClick={shoot} disabled={!stream || busy} aria-label="Prendre la photo">
          <span />
        </button>
        <span style={{ width: 44 }} />
      </div>
      <p class="camera-tip">Téléphone à plat, ~25 cm au-dessus du verre · évitez l’ombre du téléphone</p>
    </div>
  );
}
