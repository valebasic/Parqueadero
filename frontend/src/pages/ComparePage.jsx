import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api.js';
import { formatCOP, formatDuration, todayIso } from '../lib/format.js';

// Comparativo entre sedes (RF33): ingresos, ocupación, ticket y estancia promedio y productividad
// por empleado, con gráfica de barras por indicador y la tabla completa.
const METRICS = [
  { key: 'income', label: 'Ingresos', fmt: formatCOP },
  { key: 'occupancyAverage', label: 'Ocupación promedio', fmt: (v) => `${v}%` },
  { key: 'ticketAverage', label: 'Ticket promedio', fmt: formatCOP },
  { key: 'averageStayMinutes', label: 'Estancia promedio', fmt: formatDuration },
  { key: 'salesPerHour', label: 'Ventas por hora trabajada', fmt: formatCOP },
  { key: 'incomePerEmployee', label: 'Ingresos por empleado', fmt: formatCOP },
];

function monthStart() {
  return `${todayIso().slice(0, 8)}01`;
}

export default function ComparePage() {
  const [range, setRange] = useState({ from: monthStart(), to: todayIso() });
  const [metric, setMetric] = useState('income');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet(`/admin/compare?from=${range.from}&to=${range.to}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [range]);

  const m = METRICS.find((x) => x.key === metric);
  const values = data ? data.sites.map((s) => ({ name: s.site.name, value: s[metric] })) : [];
  const max = Math.max(1, ...values.map((v) => v.value ?? 0));
  const set = (k) => (e) => setRange((r) => ({ ...r, [k]: e.target.value }));

  return (
    <div className="nx-stack">
      <section className="nx-card">
        <div className="nx-filters">
          <label className="nx-form__field"><span>Desde</span><input type="date" value={range.from} onChange={set('from')} /></label>
          <label className="nx-form__field"><span>Hasta</span><input type="date" value={range.to} onChange={set('to')} /></label>
          <label className="nx-form__field nx-filters__wide">
            <span>Indicador de la gráfica</span>
            <select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {METRICS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
          </label>
        </div>
      </section>
      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}
      {data && (
        <>
          <section className="nx-card">
            <h2 className="nx-card__title nx-card__title--spaced">{m.label} por sede</h2>
            <div className="nx-bars" role="img" aria-label={`${m.label} por sede`}>
              {values.map((v) => (
                <div key={v.name} className="nx-bars__row">
                  <span>{v.name}</span>
                  <div className="nx-bars__track">
                    <div className="nx-bars__fill" style={{ width: `${v.value == null ? 0 : Math.max(1, (v.value / max) * 100)}%` }} />
                  </div>
                  <span className="nx-bars__value">{v.value == null ? '—' : m.fmt(v.value)}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="nx-card">
            <div className="nx-table-wrap">
              <table className="nx-table">
                <thead>
                  <tr>
                    <th>Sede</th>
                    <th className="nx-num">Ingresos</th>
                    <th className="nx-num">Ventas</th>
                    <th className="nx-num">Ticket promedio</th>
                    <th className="nx-num">Estancia promedio</th>
                    <th className="nx-num">Ocupación promedio</th>
                    <th className="nx-num">Empleados</th>
                    <th className="nx-num">Horas trabajadas</th>
                    <th className="nx-num">Ventas / hora</th>
                    <th className="nx-num">Ingresos / empleado</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sites.map((s) => (
                    <tr key={s.site.id}>
                      <td><strong>{s.site.name}</strong></td>
                      <td className="nx-num">{formatCOP(s.income)}</td>
                      <td className="nx-num">{s.sales}</td>
                      <td className="nx-num">{s.ticketAverage == null ? '—' : formatCOP(s.ticketAverage)}</td>
                      <td className="nx-num">{s.averageStayMinutes == null ? '—' : formatDuration(s.averageStayMinutes)}</td>
                      <td className="nx-num">{s.occupancyAverage == null ? '—' : `${s.occupancyAverage}%`}</td>
                      <td className="nx-num">{s.employees}</td>
                      <td className="nx-num">{s.workedHours}</td>
                      <td className="nx-num">{s.salesPerHour == null ? '—' : formatCOP(s.salesPerHour)}</td>
                      <td className="nx-num">{s.incomePerEmployee == null ? '—' : formatCOP(s.incomePerEmployee)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="nx-muted nx-small">
              Ingresos = parqueadero + mensualidades + otros ingresos. Ocupación promedio = tiempo de los vehículos dentro sobre la
              capacidad de la sede en el rango. Empleados = quienes tuvieron turno en la sede.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
