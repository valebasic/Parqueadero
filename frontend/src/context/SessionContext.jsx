import { createContext, useCallback, useContext, useMemo, useState } from 'react';

// Sesión del usuario en el frontend.
// FASE 1: sesión simulada (sin backend) solo para poder ver el layout por rol.
// En la Fase 3 se reemplaza por el login real con JWT contra /api/auth.
const STORAGE_KEY = 'nexo_session';
const SessionContext = createContext(null);

function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }) {
  const [session, setSession] = useState(readStoredSession);

  const login = useCallback(({ username, role }) => {
    const next = {
      user: { username, role },
      // Datos de ejemplo hasta que existan sedes, zonas y turnos en la API
      sede: { id: null, name: 'Facaparking' },
      zona: null,
      turno: null,
    };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* el almacenamiento puede estar bloqueado; la sesión vive solo en memoria */
    }
    setSession(next);
  }, []);

  const logout = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* sin efecto */
    }
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, login, logout }), [session, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession debe usarse dentro de <SessionProvider>');
  return ctx;
}
