import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH is set by the GitHub Pages workflow (e.g. /OptiFrame/).
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'mat/*', 'samples/*'],
      manifest: {
        name: 'OptiFrame',
        short_name: 'OptiFrame',
        description: 'Mesurer un verre recyclé avec un téléphone et générer une monture imprimable en 3D.',
        lang: 'fr',
        theme_color: '#0f766e',
        background_color: '#0b1f1e',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // heavy runtimes (OpenCV.js, ONNX Runtime, model) are cached for offline use
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,json,wasm,onnx,mjs,pdf}'],
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ['onnxruntime-web', 'manifold-3d'] },
});
