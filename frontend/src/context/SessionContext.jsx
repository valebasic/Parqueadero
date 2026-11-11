import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  loginRequest,
  logoutRequest,
  onSessionLost,
  refreshSession,
  setAccessToken,
} from '../lib/api.js';
import { broadcastLogout, subscribeToLogout } from '../lib/activity.js';

// Sesión del usuario contra la API (JWT en memoria + cookie httpOnly de sesión).
//   status: 'loading' (revisando si hay sesión) | 'anonymous' | 'authenticated'
//   endReason: por qué terminó la última sesión ('idle', 'expired', 'logout'…), para avisarlo en el login
const SessionContext = createContext(null);

const REASON_BY_CODE = {
  SESSION_IDLE: 'idle',
  SESSION_EXPIRED: 'expired',
  SESSION_REVOKED: 'revoked',
  USER_INACTIVE: 'inactive',
};

export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, session: null, endReason: null });
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  const endSession = useCallback((reason) => {
    setAccessToken(null);
    setState({ status: 'anonymous', user: null, session: null, endReason: reason ?? null });
  }, []);

  // Al abrir o recargar la página: si la cookie de sesión sigue viva, se recupera la sesión
  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then((data) => {
        if (!cancelled) setState({ status: 'authenticated', user: data.user, session: data.session, endReason: null });
      })
      .catch((err) => {
        if (!cancelled) endSession(REASON_BY_CODE[err.code]);
      });
    return () => {
      cancelled = true;
    };
  }, [endSession]);

  // La API avisa que la sesión terminó (inactividad, revocada, usuario desactivado…)
  useEffect(() => {
    onSessionLost((code) => {
      if (statusRef.current === 'authenticated') endSession(REASON_BY_CODE[code] || 'revoked');
    });
    return () => onSessionLost(null);
  }, [endSession]);

  // Cerrar sesión en una pestaña la cierra en las demás
  useEffect(() => subscribeToLogout((reason) => endSession(reason)), [endSession]);

  const login = useCallback(async (username, password) => {
    const data = await loginRequest(username, password);
    setState({ status: 'authenticated', user: data.user, session: data.session, endReason: null });
    return data.user;
  }, []);

  const logout = useCallback(
    async (reason = 'logout') => {
      try {
        await logoutRequest();
      } catch {
        /* aunque el servidor no responda, la sesión local se cierra */
      }
      broadcastLogout(reason);
      endSession(reason);
    },
    [endSession],
  );

  // Renueva el JWT (y le dice al servidor que el usuario sigue activo)
  const keepAlive = useCallback(async () => {
    try {
      const data = await refreshSession();
      setState((s) => ({ ...s, user: data.user, session: data.session }));
    } catch (err) {
      endSession(REASON_BY_CODE[err.code] || 'revoked');
    }
  }, [endSession]);

  const value = useMemo(
    () => ({ ...state, login, logout, keepAlive }),
    [state, login, logout, keepAlive],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession debe usarse dentro de <SessionProvider>');
  return ctx;
}
