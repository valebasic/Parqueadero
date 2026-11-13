import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// En desarrollo (y en `vite preview`), Vite reenvía /api y /socket.io al backend: un solo origen.
// PWA (RF62): el service worker guarda la app (HTML, JS, CSS, íconos) para que cargue sin internet.
// La API NUNCA se guarda en el service worker: los datos sin conexión viven cifrados en IndexedDB.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:3000';
  const proxy = {
    '/api': { target: apiTarget, changeOrigin: true },
    '/socket.io': { target: apiTarget, ws: true, changeOrigin: true },
  };

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: null, // se registra en src/main.jsx
        includeAssets: ['favicon.png'],
        manifest: {
          name: 'Nexo.app — Parqueadero',
          short_name: 'Nexo.app',
          description: 'Operación del parqueadero: entradas, salidas, caja y mensualidades.',
          lang: 'es-CO',
          start_url: '/entradas',
          display: 'standalone',
          background_color: '#f5f7fa',
          theme_color: '#0b2748',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Íconos y manifiesto los agrega el plugin; repetirlos aquí rompe la instalación ("Entry already exists")
          globPatterns: ['**/*.{js,css,html}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          cleanupOutdatedCaches: true,
        },
        devOptions: { enabled: false },
      }),
    ],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
  };
});
