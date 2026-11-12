import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getAccessToken, onNetworkChange } from '../lib/api.js';
import { useSession } from './SessionContext.jsx';
import { useShift } from './ShiftContext.jsx';
import { useSiteEvents } from './RealtimeContext.jsx';
import { hasKey, queueCount } from '../lib/offline/secureStore.js';
import { refreshSnapshot, syncQueue } from '../lib/offline/engine.js';

// Estado de conexión, cola y sincronización (RF60, RF62).
//   online:  hay comunicación con el servidor (navegador en línea Y la API responde)
//   pending: operaciones en cola por sincronizar
//   sync:    { done, total } mientras sincroniza
//   lastSync: resumen de la última sincronización (aplicadas / en conflicto)
const OfflineContext = createContext(null);

const HEARTBEAT_MS = 10000;
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000;

export function OfflineProvider({ children }) {
  const session = useSession();
  const { status, user, offline: sessionOffline, locked, goOffline, reconnect, endSession } = session;
  const { shift } = useShift();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pending, setPending] = useState(0);
  const [sync, setSync] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [syncError, setSyncError] = useState('');
  const syncingRef = useRef(false);
  const userId = user?.id;

  // --- Detección de conexión ---
  useEffect(() => {
    const goneOffline = () => setOnline(false);
    const maybeOnline = () => {
      // El navegador dice "en línea": se confirma con el servidor
      fetch('/api/health', { cache: 'no-store' }).then((r) => setOnline(r.ok)).catch(() => setOnline(false));
    };
    window.addEventListener('offline', goneOffline);
    window.addEventListener('online', maybeOnline);
    onNetworkChange((ok) => setOnline(ok));
    return () => {
      window.removeEventListener('offline', goneOffline);
      window.removeEventListener('online', maybeOnline);
      onNetworkChange(null);
    };
  }, []);

  // Sin conexión se pregunta al servidor cada 10 s si ya volvió
  useEffect(() => {
    if (online) return undefined;
    const id = setInterval(() => {
      if (!navigator.onLine) return;
      fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok && setOnline(true)).catch(() => {});
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [online]);

  // La sesión pasa a modo sin conexión al perder el servidor
  useEffect(() => {
    if (!online && status === 'authenticated' && !sessionOffline) goOffline();
  }, [online, status, sessionOffline, goOffline]);

  const refreshCount = useCallback(async () => {
    if (!userId) return setPending(0);
    try {
      setPending(await queueCount(userId));
    } catch {
      /* IndexedDB no disponible */
    }
    return undefined;
  }, [userId]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount, locked]);

  // --- Sincronización ---
  const syncNow = useCallback(async () => {
    if (syncingRef.current || !userId || !hasKey(userId)) return null;
    if ((await queueCount(userId)) === 0) return null;
    syncingRef.current = true;
    setSyncError('');
    try {
      const summary = await syncQueue({ userId, accessToken: getAccessToken(), onProgress: setSync });
      setLastSync({ ...summary, at: Date.now() });
      return summary;
    } catch (err) {
      setSyncError(err.message);
      if (err.code === undefined && err.status === undefined) setOnline(false);
      return null;
    } finally {
      syncingRef.current = false;
      setSync(null);
      refreshCount();
    }
  }, [userId, refreshCount]);

  // Volvió la conexión: primero se sube lo pendiente (con el token de sincronización si hace falta)
  // y luego se confirma la sesión. Si ya no es válida, se pide iniciar sesión.
  useEffect(() => {
    if (!online || status !== 'authenticated' || locked) return;
    let cancelled = false;
    (async () => {
      if (sessionOffline) {
        const res = await reconnect();
        await syncNow();
        if (!cancelled && !res.ok && res.code && res.code !== 'NETWORK') {
          endSession(res.code === 'SESSION_IDLE' ? 'idle' : 'expired');
        }
      } else {
        await syncNow();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [online, status, locked, sessionOffline, reconnect, syncNow, endSession]);

  // Reintento periódico mientras quede algo en la cola
  useEffect(() => {
    if (!online || pending === 0) return undefined;
    const id = setInterval(() => syncNow(), 30000);
    return () => clearInterval(id);
  }, [online, pending, syncNow]);

  // --- Copia local (tarifas, mensualidades, entradas abiertas) ---
  const siteId = shift?.site.id;
  const refreshLocal = useCallback(() => {
    if (!online || sessionOffline || !siteId || !userId || !hasKey(userId)) return;
    refreshSnapshot(siteId, shift, userId).catch(() => {});
  }, [online, sessionOffline, siteId, shift, userId]);

  useEffect(() => {
    refreshLocal();
    const id = setInterval(refreshLocal, SNAPSHOT_EVERY_MS);
    return () => clearInterval(id);
  }, [refreshLocal, locked]);

  // Cada evento de la sede que cambia la copia local la refresca
  useSiteEvents(siteId, ['entry:created', 'entry:exited', 'monthly:alerts', 'shift:opened', 'shift:closed', 'shift:handover'], () => refreshLocal(), {
    debounceMs: 800,
  });

  const value = useMemo(
    () => ({
      online: online && !sessionOffline,
      pending,
      sync,
      lastSync,
      syncError,
      syncNow,
      notifyQueued: refreshCount,
      refreshLocal,
    }),
    [online, sessionOffline, pending, sync, lastSync, syncError, syncNow, refreshCount, refreshLocal],
  );
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline() {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useOffline debe usarse dentro de <OfflineProvider>');
  return ctx;
}
