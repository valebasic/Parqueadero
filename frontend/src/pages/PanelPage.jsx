import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api.js';
import { useRealtime } from '../context/RealtimeContext.jsx';
import { formatCOP, formatDateTime, formatTime12h } from '../lib/format.js';
import AlertsPanel from '../components/panel/AlertsPanel.jsx';
import ZonesInCharge from '../components/panel/ZonesInCharge.jsx';

// Panel multisede en tiempo real (RF28): consolidado, alertas (RF32), sedes y zonas a cargo (RF31). AG: todas las sedes; AS: las suyas.
// Se recarga con cualquier evento de tiempo real de sus sedes (y cada minuto).
const CONNECTION = {
  ONLINE: ['En línea', 'nx-badge--ok'],
  OFFLINE: ['Sin conexión', 'nx-badge--danger'],
  NO_SHIFT: ['Sin turno', 'nx-badge--off'],
};

function Kpi({ label, value, sub, tone }) {
  return (
    <div className={`nx-stat${tone ? ` nx-stat--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small className="nx-muted">{sub}</small>}
    </div>
  );
}

function Occupancy({ value }) {
  if (value == null) return <span className="nx-muted">—</span>;
  return (
    <div className="nx-occ">
      <div className="nx-occupancy" aria-hidden="true"><span style={{ width: `${Math.min(100, value)}%` }} /></div>
      <small className={value >= 90 ? 'is-danger' : ''}>{value}%</small>
    </div>
  );
}

// Recarga con los eventos de cualquier sede (agrupados)
export function useAnySiteEvents(handler, debounceMs = 600) {
  const { subscribe } = useRealtime();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let timer = null;
    const unsubscribe = subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => ref.current(), debounceMs);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, debounceMs]);
}

export default function PanelPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await apiGet('/admin/overview', { background: true }));
      setError('');
      setTick((t) => t + 1);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useAnySiteEvents(load);
  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  if (error && !data) return <div className="nx-banner nx-banner--error" role="alert">{error}</div>;
  if (!data) return <p className="nx-muted">Cargando…</p>;
  const c = data.consolidated;

  return (
    <div className="nx-stack">
      <section className="nx-card">
        <header className="nx-card__header">
          <h2 className="nx-card__title">Consolidado · {data.sites.length} {data.sites.length === 1 ? 'sede' : 'sedes'}</h2>
          <small className="nx-muted">Actualizado {formatTime12h(data.generatedAt, { seconds: true })}</small>
        </header>
        <div className="nx-stats">
          <Kpi label="Vehículos dentro" value={c.inside.total} sub={c.occupancy.total != null ? `Ocupación ${c.occupancy.total}% de ${c.capacity.total}` : 'Sin capacidad definida'} />
          <Kpi label="Entradas / salidas hoy" value={`${c.today.entries} / ${c.today.exits}`} />
          <Kpi label="Ventas hoy" value={formatCOP(c.sales.total)} sub={`Efectivo ${formatCOP(c.sales.cash)} · Electrónico ${formatCOP(c.sales.electronic)}`} tone="ok" />
          <Kpi label="Cobros pendientes" value={c.pending.count} sub={formatCOP(c.pending.total)} tone={c.pending.count ? 'info' : undefined} />
          <Kpi label="Mensualidades" value={`${c.monthly.expiring} por vencer`} sub={`${c.monthly.overdue} en mora`} tone={c.monthly.overdue ? 'danger' : undefined} />
          <Kpi label="Sedes" value={`${c.connection.online} en línea`} sub={`${c.connection.offline} sin conexión · ${c.connection.noShift} sin turno`} tone={c.connection.offline ? 'danger' : undefined} />
        </div>
      </section>

      <AlertsPanel sites={data.sites.map((s) => s.site)} refreshKey={tick} />

      <section className="nx-card">
        <h2 className="nx-card__title nx-card__title--spaced">Por sede</h2>
        <div className="nx-table-wrap">
          <table className="nx-table">
            <thead>
              <tr>
                <th>Sede</th>
                <th>Conexión</th>
                <th className="nx-num">Dentro</th>
                <th>Ocupación</th>
                <th className="nx-num">Entradas / salidas</th>
                <th className="nx-num">Ventas hoy</th>
                <th className="nx-num">Pendientes</th>
                <th>Mensualidades</th>
                <th>Turnos abiertos</th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map((s) => {
                const [label, cls] = CONNECTION[s.connection.status];
                return (
                  <tr key={s.site.id}>
                    <td><strong>{s.site.name}</strong></td>
                    <td className="nx-conn">
                      <span className={`nx-badge ${cls}`}>{label}</span>
                      <div className="nx-muted nx-small">
                        {s.connection.lastSync ? `Sincronizó ${formatDateTime(s.connection.lastSync)}` : 'Sin sincronizaciones'}
                      </div>
                      {s.connection.status === 'OFFLINE' && s.connection.lastSeen && (
                        <div className="nx-muted nx-small">Visto {formatDateTime(s.connection.lastSeen)}</div>
                      )}
                    </td>
                    <td className="nx-num">
                      {s.inside.total}
                      <div className="nx-muted nx-small">Carros {s.inside.byType.CAR} · Motos {s.inside.byType.MOTORCYCLE} · Ciclas {s.inside.byType.BICYCLE}</div>
                    </td>
                    <td><Occupancy value={s.occupancy.total} /></td>
                    <td className="nx-num">{s.today.entries} / {s.today.exits}</td>
                    <td className="nx-num">
                      {formatCOP(s.sales.total)}
                      <div className="nx-muted nx-small">Ef. {formatCOP(s.sales.cash)} · El. {formatCOP(s.sales.electronic)}</div>
                    </td>
                    <td className="nx-num">{s.pending.count ? `${s.pending.count} · ${formatCOP(s.pending.total)}` : '—'}</td>
                    <td>
                      {s.monthly.expiring} por vencer
                      {s.monthly.overdue > 0 && <div className="is-danger nx-small">{s.monthly.overdue} en mora</div>}
                    </td>
                    <td className="nx-small">
                      {s.openShifts.length === 0
                        ? <span className="nx-muted">—</span>
                        : s.openShifts.map((sh) => (
                            <div key={sh.id}>
                              <i className={`nx-dot ${sh.online ? 'is-on' : 'is-off'}`} aria-label={sh.online ? 'conectado' : 'desconectado'} />
                              {sh.zone}: {sh.user}
                            </div>
                          ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <ZonesInCharge refreshKey={tick} />
    </div>
  );
}
