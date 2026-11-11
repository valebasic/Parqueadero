import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo, Vite reenvía /api (y luego /socket.io) al backend: el navegador ve un solo origen.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        // Tiempo real (Fase 6)
        '/socket.io': { target: apiTarget, ws: true, changeOrigin: true },
      },
    },
  };
});
