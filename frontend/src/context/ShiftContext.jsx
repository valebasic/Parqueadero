import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiGet } from '../lib/api.js';
import { useSession } from './SessionContext.jsx';
import { useSiteEvents } from './RealtimeContext.jsx';

// Turno abierto del usuario (o null). Lo usan la barra superior, Entradas, Caja, Ventas y Pendientes.
const ShiftContext = createContext(null);

export function ShiftProvider({ children }) {
  const { status } = useSession();
  const [shift, setShift] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setShift(await apiGet('/shifts/current'));
    } catch {
      setShift(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated') refresh();
    else {
      setShift(null);
      setLoading(status === 'loading');
    }
  }, [status, refresh]);

  // Tiempo real: ventas, movimientos y cambios de turno de la sede refrescan el resumen de la caja
  useSiteEvents(
    shift?.site.id,
    ['shift:opened', 'shift:closed', 'shift:handover', 'cash:movement', 'sales:changed', 'entry:exited'],
    () => refresh(),
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
