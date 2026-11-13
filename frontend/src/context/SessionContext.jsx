import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  loginRequest,
  logoutRequest,
  onSessionLost,
  refreshSession,
  setAccessToken,
} from '../lib/api.js';
import { broadcastLogout, subscribeToLogout } from '../lib/activity.js';
import {
  activeOfflineGrant,
  endOfflineGrant,
  hasKey,
  lockKey,
  prepareOffline,
  refreshOfflineGrant,
  restoreKeyFromSession,
  unlockWithPassword,
} from '../lib/offline/secureStore.js';

// Sesión del usuario contra la API (JWT en memoria + cookie httpOnly de sesión).
//   status: 'loading' | 'anonymous' | 'authenticated'
//   offline: la sesión sigue SIN confirmar con el servidor (se cayó internet). Dura hasta 8 h desde
//            la última renovación en línea. Sin conexión no se puede iniciar una sesión nueva.
//   locked:  la clave local no está disponible (navegador reabierto o bloqueo por inactividad sin
//            conexión): se desbloquea con la contraseña, verificada localmente con PBKDF2.
//   endReason: por qué terminó la última sesión ('idle', 'expired', 'logout'…), para el login
const SessionContext = createContext(null);

const REASON_BY_CODE = {
  SESSION_IDLE: 'idle',
  SESSION_EXPIRED: 'expired',
  SESSION_REVOKED: 'revoked',
  USER_INACTIVE: 'inactive',
};

// Usuario armado con los datos guardados para trabajar sin conexión
const userFromGrant = (g) => ({
  id: g.userId,
  username: g.username,
  fullName: g.fullName,
  role: g.role,
  sites: g.sites ?? [],
  allSites: g.role === 'AG',
});

export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, session: null, endReason: null, offline: false, locked: false });
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  const endSession = useCallback((reason) => {
    setAccessToken(null);
    setState({ status: 'anonymous', user: null, session: null, endReason: reason ?? null, offline: false, locked: false });
  }, []);

  // Sin internet al abrir: se continúa con los datos guardados si hay un acceso sin conexión vigente
  const resumeOffline = useCallback(async (reason) => {
    const grant = await activeOfflineGrant().catch(() => null);
    if (!grant) {
      endSession(reason);
      return;
    }
    const unlocked = await restoreKeyFromSession(grant.userId);
    setState({
      status: 'authenticated',
      user: userFromGrant(grant),
      session: { idleTimeoutSeconds: grant.role === 'OP' ? 900 : 1800 },
      endReason: null,
      offline: true,
      locked: !unlocked,
    });
  }, [endSession]);

  // Al abrir o recargar la página: si la cookie de sesión sigue viva, se recupera la sesión
  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then(async (data) => {
        if (cancelled) return;
        const unlocked = await restoreKeyFromSession(data.user.id);
        if (unlocked) refreshOfflineGrant(data.user.id, data.offlineToken).catch(() => {});
        setState({ status: 'authenticated', user: data.user, session: data.session, endReason: null, offline: false, locked: false });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.code === 'NETWORK') resumeOffline();
        else endSession(REASON_BY_CODE[err.code]);
      });
    return () => {
      cancelled = true;
    };
  }, [endSession, resumeOffline]);

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
    // Prepara la operación sin conexión: clave derivada de la contraseña (PBKDF2), nunca la contraseña
    try {
      await prepareOffline(data.user, password, data.offlineToken);
    } catch {
      /* sin IndexedDB/WebCrypto: la app funciona, pero no sin conexión */
    }
    setState({ status: 'authenticated', user: data.user, session: data.session, endReason: null, offline: false, locked: false });
    return data.user;
  }, []);

  const logout = useCallback(
    async (reason = 'logout') => {
      const userId = state.user?.id;
      try {
        await logoutRequest();
      } catch {
        /* aunque el servidor no responda, la sesión local se cierra */
      }
      if (userId) await endOfflineGrant(userId).catch(() => {});
      broadcastLogout(reason);
      endSession(reason);
    },
    [endSession, state.user?.id],
  );

  // Renueva el JWT (y le dice al servidor que el usuario sigue activo). Sin internet no hace nada.
  const keepAlive = useCallback(async () => {
    try {
      const data = await refreshSession();
      if (hasKey(data.user.id)) refreshOfflineGrant(data.user.id, data.offlineToken).catch(() => {});
      setState((s) => ({ ...s, user: data.user, session: data.session, offline: false }));
      return true;
    } catch (err) {
      if (err.code === 'NETWORK') return false;
      endSession(REASON_BY_CODE[err.code] || 'revoked');
      return false;
    }
  }, [endSession]);

  // Volvió internet: confirma la sesión con el servidor. Si ya no es válida (p. ej. venció por
  // inactividad mientras no había conexión), quien llama decide (primero se sincroniza la cola).
  const reconnect = useCallback(async () => {
    try {
      const data = await refreshSession();
      if (hasKey(data.user.id)) refreshOfflineGrant(data.user.id, data.offlineToken).catch(() => {});
      setState((s) => ({ ...s, user: data.user, session: data.session, offline: false }));
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code };
    }
  }, []);

  const goOffline = useCallback(() => setState((s) => (s.status === 'authenticated' ? { ...s, offline: true } : s)), []);

  // Bloqueo local (inactividad sin conexión) y desbloqueo con la contraseña
  const lock = useCallback(() => {
    lockKey();
    setState((s) => ({ ...s, locked: true }));
  }, []);
  const unlock = useCallback(
    async (password) => {
      const ok = await unlockWithPassword(state.user.id, password);
      if (ok) setState((s) => ({ ...s, locked: false }));
      return ok;
    },
    [state.user?.id],
  );

  const value = useMemo(
    () => ({ ...state, login, logout, keepAlive, reconnect, goOffline, lock, unlock, endSession }),
    [state, login, logout, keepAlive, reconnect, goOffline, lock, unlock, endSession],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession debe usarse dentro de <SessionProvider>');
  return ctx;
}
