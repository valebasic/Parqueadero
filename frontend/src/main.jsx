import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { SessionProvider } from './context/SessionContext.jsx';
import { ShiftProvider } from './context/ShiftContext.jsx';
import { RealtimeProvider } from './context/RealtimeContext.jsx';
import { ReceiptProvider } from './components/Receipt.jsx';
import { OfflineProvider } from './context/OfflineContext.jsx';
import './styles/theme.css';
import './styles/layout.css';
import './styles/operation.css';
import './styles/management.css';
import './styles/admin.css';
import './styles/receipt.css';

// PWA: el service worker (generado por vite-plugin-pwa) guarda la app para abrirla sin internet.
// Toma el control al instalarse (skipWaiting + clientsClaim): las versiones nuevas se aplican solas.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .catch((err) => console.warn('No se pudo registrar el service worker:', err?.message ?? err));
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <RealtimeProvider>
        <ShiftProvider>
          <OfflineProvider>
          <ReceiptProvider>
            <App />
          </ReceiptProvider>
          </OfflineProvider>
        </ShiftProvider>
        </RealtimeProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
