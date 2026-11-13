import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiGet } from '../lib/api.js';
import { useSession } from './SessionContext.jsx';
import { useSiteEvents } from './RealtimeContext.jsx';
import { loadCachedShift } from '../lib/offline/engine.js';

// Turno abierto del usuario (o null). Lo usan la barra superior, Entradas, Caja, Ventas y Pendientes.
// Sin conexión se usa el último turno guardado en la copia local (cifrada).
const ShiftContext = createContext(null);

export function ShiftProvider({ children }) {
  const { status, offline, locked, user } = useSession();
  const [shift, setShift] = useState(null);
  const [loading, setLoading] = useState(true);
  const userId = user?.id;

  const refresh = useCallback(async () => {
    try {
      setShift(await apiGet('/shifts/current'));
    } catch (err) {
      // Sin internet se conserva el turno conocido; cualquier otro error lo limpia
      if (err.code !== 'NETWORK') setShift(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') {
      setShift(null);
      setLoading(status === 'loading');
      return;
    }
    if (offline) {
      if (locked) return;
      loadCachedShift(userId)
        .then((s) => setShift(s))
        .catch(() => {})
        .finally(() => setLoading(false));
      return;
    }
    refresh();
  }, [status, offline, locked, userId, refresh]);

  // Tiempo real: ventas, movimientos y cambios de turno de la sede refrescan el resumen de la caja
  useSiteEvents(
    shift?.site.id,
    ['shift:opened', 'shift:closed', 'shift:handover', 'cash:movement', 'sales:changed', 'entry:exited'],
    () => {
      if (!offline) refresh();
    },
  );

  const value = useMemo(() => ({ shift, loading, refresh }), [shift, loading, refresh]);
  return <ShiftContext.Provider value={value}>{children}</ShiftContext.Provider>;
}

export function useShift() {
  const ctx = useContext(ShiftContext);
  if (!ctx) throw new Error('useShift debe usarse dentro de <ShiftProvider>');
  return ctx;
}

// Sede con la que trabaja la pantalla: la del turno abierto; si no hay, la primera del usuario
export function useWorkingSite() {
  const { user } = useSession();
  const { shift } = useShift();
  const [selected, setSelected] = useState(null);
  const sites = user?.sites ?? [];
  const siteId = shift?.site.id ?? selected ?? sites[0]?.id ?? null;
  return { siteId, sites, setSiteId: setSelected, lockedByShift: Boolean(shift) };
}
