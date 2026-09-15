import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages project site: https://diddy674176.github.io/narrato/
export default defineConfig({
  base: '/narrato/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Narrato',
        short_name: 'Narrato',
        description:
          'Listen to books, PDFs, articles and photos of pages with natural on-device AI voices.',
        theme_color: '#0a0c12',
        background_color: '#0a0c12',
        display: 'standalone',
        orientation: 'any',
        start_url: '/narrato/',
        scope: '/narrato/',
        categories: ['books', 'education', 'productivity'],
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // The Kokoro worker bundle is ~2.2 MB; the default 2 MB precache cap
        // would silently leave it out and break offline playback.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2,mjs}'],
        // The ONNX runtime binary is ~21 MB - far too large to precache, but we
        // still want it available offline once it has been fetched.
        globIgnores: ['**/*.wasm'],
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-runtime',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // tesseract.js fetches its core and language data from jsDelivr.
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-cdn',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // Hash routing means index.html is the only real document.
        navigateFallback: '/narrato/index.html',
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    // The voice model runtime is inherently large; the default 500 kB warning
    // is pure noise here.
    chunkSizeWarningLimit: 2600,
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  worker: {
    format: 'es',
  },
});
