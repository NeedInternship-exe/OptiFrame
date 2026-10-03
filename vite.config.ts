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
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
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
        // the app shell is precached; the heavy engines (OpenCV.js 10 MB, ONNX
        // Runtime wasm 14 MB, model 2 MB) are cached the first time the
        // worker downloads them, so they are not fetched twice
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['opencv/**', 'models/**', 'samples/**', 'mat/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        clientsClaim: true,
        skipWaiting: true,
        // only app routes fall back to index.html: real files (the mat PDF,
        // SVG, images...) must reach the network/cache, never the app shell
        navigateFallbackDenylist: [/\.[a-z0-9]+$/i],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/opencv\//.test(url.pathname) || url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: { cacheName: 'optiframe-engines', expiration: { maxEntries: 8 } },
          },
          {
            urlPattern: ({ url }) => /\/(models|samples|mat)\//.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'optiframe-data', expiration: { maxEntries: 16 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ['onnxruntime-web', 'manifold-3d'] },
});
