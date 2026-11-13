import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { getAccessToken, refreshSession } from '../lib/api.js';
import { useSession } from './SessionContext.jsx';

// Conexión de tiempo real (Socket.IO) con la misma sesión de la API.
//   status: 'off' (sin sesión) | 'connecting' | 'live' | 'reconnecting'
//   Reconexión automática; si el JWT venció, se renueva y se reintenta.
//   Si el servidor cierra la sesión (logout en otro lado, inactividad, usuario desactivado), se sale.
const RealtimeContext = createContext(null);

const END_REASON = { IDLE: 'idle', SESSION_IDLE: 'idle', EXPIRED: 'expired', USER_DEACTIVATED: 'inactive', USER_INACTIVE: 'inactive' };

export function RealtimeProvider({ children }) {
  const { status: sessionStatus, logout } = useSession();
  const [status, setStatus] = useState('off');
  const listeners = useRef(new Set());
  const socketRef = useRef(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      setStatus('off');
      return undefined;
    }
    setStatus('connecting');
    const socket = io({
      path: '/socket.io',
      // Se evalúa en cada intento: siempre viaja el token vigente
      auth: (cb) => cb({ token: getAccessToken() }),
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setStatus('live'));
    socket.on('disconnect', () => setStatus('reconnecting'));
    socket.io.on('reconnect_attempt', () => setStatus('reconnecting'));
    socket.on('connect_error', async (err) => {
      setStatus('reconnecting');
      // Token vencido o inválido: se renueva con la cookie de sesión y se reintenta
      if (['TOKEN_EXPIRED', 'TOKEN_INVALID', 'AUTH_REQUIRED'].includes(err.message)) {
        try {
          await refreshSession();
          socket.connect();
        } catch {
          /* la sesión terminó: SessionContext lo resolverá */
        }
      }
    });
    socket.on('session:ended', ({ reason }) => {
      socket.close();
      logout(END_REASON[reason] ?? 'revoked');
    });
    socket.on('event', (evt) => {
      listeners.current.forEach((fn) => {
        try {
          fn(evt);
        } catch {
          /* un oyente con error no afecta a los demás */
        }
      });
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [sessionStatus, logout]);

  const value = useMemo(
    () => ({
      status,
      subscribe(fn) {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
    }),
    [status],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime debe usarse dentro de <RealtimeProvider>');
  return ctx;
}

/**
 * Llama a `handler(evt)` cuando llega un evento de la sede `siteId` cuyo tipo esté en `types`
 * (o cualquiera si `types` es null). Agrupa ráfagas de eventos en una sola llamada (debounce).
 */
export function useSiteEvents(siteId, types, handler, { debounceMs = 250 } = {}) {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const typesKey = types ? types.join(',') : '';

  useEffect(() => {
    if (!siteId) return undefined;
    let timer = null;
    let pending = [];
    const wanted = typesKey ? typesKey.split(',') : null;
    const unsubscribe = subscribe((evt) => {
      if (evt.siteId !== Number(siteId)) return;
      if (wanted && !wanted.includes(evt.type)) return;
      pending.push(evt);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const batch = pending;
        pending = [];
        handlerRef.current(batch);
      }, debounceMs);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [siteId, typesKey, subscribe, debounceMs]);
}
