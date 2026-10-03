// three.js preview of the generated front (+ translucent lenses in their groove).
import { useEffect, useRef, useState } from 'preact/hooks';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FrameResult } from '../frame/frame.ts';

interface Props {
  frame: FrameResult | null;
  edgeThickness: number;
}

export function Viewer3D({ frame, edgeThickness }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    group: THREE.Group;
    render: () => void;
  } | null>(null);
  const [showLenses, setShowLenses] = useState(true);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.textContent = 'Aperçu 3D indisponible (WebGL désactivé). Le fichier STL reste téléchargeable.';
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-80, 120, -200);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(120, -60, 200);
    scene.add(rim);
    const group = new THREE.Group();
    scene.add(group);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    });
    ro.observe(el);
    ctx.current = { renderer, scene, camera, controls, group, render };
    return () => {
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.innerHTML = '';
      ctx.current = null;
    };
  }, []);

  const view = (kind: 'front' | 'threeq' | 'print') => {
    const c = ctx.current;
    if (!c) return;
    const box = new THREE.Box3().setFromObject(c.group);
    const size = box.getSize(new THREE.Vector3());
    const d = Math.max(size.x / c.camera.aspect, size.y) / (2 * Math.tan((c.camera.fov * Math.PI) / 360)) * 1.25 + size.z;
    // print space: front face at z = 0 (on the bed); the front view is from -z
    const dir = kind === 'front' ? new THREE.Vector3(0, 0, -1) : kind === 'threeq' ? new THREE.Vector3(-0.55, 0.35, -0.75) : new THREE.Vector3(0.0001, 0.0001, 1);
    c.camera.position.copy(dir.normalize().multiplyScalar(d));
    c.camera.up.set(0, 1, 0);
    c.controls.target.set(0, 0, 0);
    c.controls.update();
    c.render();
  };

  useEffect(() => {
    const c = ctx.current;
    if (!c || !frame) return;
    const first = c.group.children.length === 0;
    c.group.children.slice().forEach((o) => {
      c.group.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(frame.positions.slice(), 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x14534d, roughness: 0.45, metalness: 0.05, flatShading: true }));
    c.group.add(mesh);
    if (showLenses) {
      const zc = (frame.grooveZ[0] + frame.grooveZ[1]) / 2;
      for (const l of frame.lenses) {
        const shape = new THREE.Shape(l.outline.map(([x, y]) => new THREE.Vector2(x, y)));
        const g = new THREE.ExtrudeGeometry(shape, { depth: edgeThickness, bevelEnabled: false, curveSegments: 1 });
        g.translate(0, 0, zc - edgeThickness / 2);
        const lens = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.35, roughness: 0.05, depthWrite: false }));
        c.group.add(lens);
      }
    }
    // centre the model
    const box = new THREE.Box3().setFromObject(mesh);
    const ctr = box.getCenter(new THREE.Vector3());
    c.group.position.set(-ctr.x, -ctr.y, -ctr.z);
    if (first) view('threeq');
    else c.render();
  }, [frame, showLenses, edgeThickness]);

  return (
    <div class="viewer">
      <div ref={host} class="viewer-canvas" />
      <div class="viewer-tools">
        <button class="chip-btn" onClick={() => view('front')}>
          Face
        </button>
        <button class="chip-btn" onClick={() => view('threeq')}>
          3/4
        </button>
        <button class="chip-btn" onClick={() => view('print')}>
          Côté impression
        </button>
        <label class="chip-btn">
          <input type="checkbox" checked={showLenses} onChange={(e) => setShowLenses((e.target as HTMLInputElement).checked)} /> verres
        </label>
      </div>
    </div>
  );
}
