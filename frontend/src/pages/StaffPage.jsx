import { Fragment, useCallback, useEffect, useState } from 'react';
import { apiDownload, apiGet, apiPost } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { formatCOP, formatDate, formatDateTime, todayIso } from '../lib/format.js';
import Modal from '../components/Modal.jsx';

// Personal y turnos (RF44-RF46): horas trabajadas (diurnas, nocturnas, dominicales/festivas de
// Colombia) por turno, día, semana o mes; reporte de turnos con diferencias; ajuste autorizado.
const GROUPS = [
  ['shift', 'Por turno'],
  ['day', 'Por día'],
  ['week', 'Por semana'],
  ['month', 'Por mes'],
];
const h = (v) => (v ? v.toLocaleString('es-CO', { maximumFractionDigits: 2 }) : '0');

function monthStart() {
  return `${todayIso().slice(0, 8)}01`;
}

function periodLabel(p, groupBy) {
  if (groupBy === 'shift') return `${formatDateTime(p.start)} → ${p.end ? formatDateTime(p.end) : 'abierto'}`;
  if (groupBy === 'week') return `Semana del ${formatDate(p.label)}`;
  if (groupBy === 'month') return p.label.split('-').reverse().join('/');
  return formatDate(p.label);
}

export default function StaffPage() {
  const [tab, setTab] = useState('hours');
  const [filters, setFilters] = useState({ from: monthStart(), to: todayIso(), siteId: 'all', groupBy: 'day' });
  const [sites, setSites] = useState([]);
  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const qs = `from=${filters.from}&to=${filters.to}${filters.siteId !== 'all' ? `&siteId=${filters.siteId}` : ''}`;

  useEffect(() => {
    apiGet('/sites').then(setSites).catch(() => {});
  }, []);

  return (
    <div className="nx-stack">
      <section className="nx-card nx-card--tabs">
        <div className="nx-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'hours'} className={tab === 'hours' ? 'is-active' : ''} onClick={() => setTab('hours')}>Horas trabajadas</button>
          <button type="button" role="tab" aria-selected={tab === 'shifts'} className={tab === 'shifts' ? 'is-active' : ''} onClick={() => setTab('shifts')}>Reporte de turnos</button>
        </div>
      </section>
      <section className="nx-card">
        <div className="nx-filters">
          <label className="nx-form__field"><span>Desde</span><input type="date" value={filters.from} onChange={set('from')} /></label>
          <label className="nx-form__field"><span>Hasta</span><input type="date" value={filters.to} onChange={set('to')} /></label>
          <label className="nx-form__field">
            <span>Sede</span>
            <select value={filters.siteId} onChange={set('siteId')}>
              <option value="all">Todas mis sedes</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          {tab === 'hours' ? (
            <label className="nx-form__field">
              <span>Agrupar</span>
              <select value={filters.groupBy} onChange={set('groupBy')}>
                {GROUPS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
          ) : (
            <div className="nx-filters__actions">
              <button type="button" className="nx-btn nx-btn--ghost" onClick={() => apiDownload(`/admin/shift-report/export?${qs}`, `turnos_${filters.from}_${filters.to}.xlsx`)}>
                Exportar Excel
              </button>
            </div>
          )}
        </div>
      </section>
      {tab === 'hours' ? <Hours qs={qs} groupBy={filters.groupBy} /> : <ShiftReport qs={qs} />}
    </div>
  );
}

function Hours({ qs, groupBy }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet(`/admin/hours?${qs}&groupBy=${groupBy}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [qs, groupBy]);

  if (error) return <div className="nx-banner nx-banner--error" role="alert">{error}</div>;
  if (!data) return <p className="nx-muted">Cargando…</p>;
  return (
    <section className="nx-card">
      <p className="nx-muted nx-small">
        Hora de Colombia. Nocturnas: de 7:00 p. m. a 6:00 a. m. (desde el 25/12/2025; antes desde las 9:00 p. m.). Dominicales y
        festivos según el calendario colombiano. Si un turno fue ajustado, cuenta la hora ajustada.
      </p>
      <div className="nx-table-wrap">
        <table className="nx-table">
          <thead>
            <tr>
              <th>Empleado</th>
              <th className="nx-num">Turnos</th>
              <th className="nx-num">Total h</th>
              <th className="nx-num">Diurnas</th>
              <th className="nx-num">Nocturnas</th>
              <th className="nx-num">Dom./fest. diurnas</th>
              <th className="nx-num">Dom./fest. nocturnas</th>
            </tr>
          </thead>
          <tbody>
            {data.employees.length === 0 && <tr><td colSpan={7} className="nx-muted">Sin turnos en el rango.</td></tr>}
            {data.employees.map((e) => (
              <Fragment key={e.user.id}>
                <tr className="nx-row--strong">
                  <td>
                    <button type="button" className="nx-linkbtn" onClick={() => setOpen(open === e.user.id ? null : e.user.id)} aria-expanded={open === e.user.id}>
                      {open === e.user.id ? '▾' : '▸'} {e.user.fullName}
                    </button>
                  </td>
                  <td className="nx-num">{e.shifts}</td>
                  <td className="nx-num">{h(e.hours.total)}</td>
                  <td className="nx-num">{h(e.hours.day)}</td>
                  <td className="nx-num">{h(e.hours.night)}</td>
                  <td className="nx-num">{h(e.hours.holidayDay)}</td>
                  <td className="nx-num">{h(e.hours.holidayNight)}</td>
                </tr>
                {open === e.user.id && e.periods.map((p) => (
                  <tr key={p.key}>
                    <td className="nx-small">
                      {periodLabel(p, groupBy)}
                      {p.holiday && <span className="nx-badge nx-badge--info">{p.holiday}</span>}
                      {p.adjusted && <span className="nx-badge nx-badge--warn">Ajustado</span>}
                    </td>
                    <td />
                    <td className="nx-num">{h(p.hours.total)}</td>
                    <td className="nx-num">{h(p.hours.day)}</td>
                    <td className="nx-num">{h(p.hours.night)}</td>
                    <td className="nx-num">{h(p.hours.holidayDay)}</td>
                    <td className="nx-num">{h(p.hours.holidayNight)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
          {data.employees.length > 0 && (
            <tfoot>
              <tr className="nx-row--strong">
                <td>Total</td>
                <td />
                <td className="nx-num">{h(data.totals.total)}</td>
                <td className="nx-num">{h(data.totals.day)}</td>
                <td className="nx-num">{h(data.totals.night)}</td>
                <td className="nx-num">{h(data.totals.holidayDay)}</td>
                <td className="nx-num">{h(data.totals.holidayNight)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

function ShiftReport({ qs }) {
  const { user } = useSession();
  const [data, setData] = useState(null);
  const [adjusting, setAdjusting] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    apiGet(`/admin/shift-report?${qs}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [qs]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="nx-banner nx-banner--error" role="alert">{error}</div>;
  if (!data) return <p className="nx-muted">Cargando…</p>;
  const t = data.totals;
  return (
    <>
      <section className="nx-card">
        <div className="nx-stats">
          <div className="nx-stat"><span>Turnos</span><strong>{t.shifts}</strong><small className="nx-muted">{h(t.hours)} h trabajadas</small></div>
          <div className="nx-stat nx-stat--ok"><span>Ventas</span><strong>{formatCOP(t.sales)}</strong></div>
          <div className="nx-stat nx-stat--danger"><span>Faltantes</span><strong>{formatCOP(t.shortage)}</strong><small className="nx-muted">{t.withDifference} turnos con diferencia</small></div>
          <div className="nx-stat"><span>Sobrantes</span><strong>{formatCOP(t.surplus)}</strong><small className="nx-muted">{t.adjusted} ajustados</small></div>
        </div>
      </section>
      <section className="nx-card">
        <div className="nx-table-wrap">
          <table className="nx-table">
            <thead>
              <tr>
                <th>Empleado</th>
                <th>Sede · zona</th>
                <th>Trabajado</th>
                <th className="nx-num">Horas</th>
                <th className="nx-num">Ventas</th>
                <th className="nx-num">Esperado</th>
                <th className="nx-num">Contado</th>
                <th className="nx-num">Diferencia</th>
                <th aria-label="Ajuste" />
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && <tr><td colSpan={9} className="nx-muted">Sin turnos en el rango.</td></tr>}
              {data.items.map((i) => (
                <tr key={i.shiftId}>
                  <td>{i.user.fullName}</td>
                  <td>{i.site.name}<div className="nx-muted nx-small">{i.zone.name}</div></td>
                  <td className="nx-small">
                    {formatDateTime(i.workedStart)}<br />{i.open ? <span className="nx-badge nx-badge--info">Abierto</span> : formatDateTime(i.workedEnd)}
                    {i.adjusted && <div><span className="nx-badge nx-badge--warn">Ajustado ({i.adjustments})</span></div>}
                  </td>
                  <td className="nx-num">{h(i.workedHours.total)}</td>
                  <td className="nx-num">{formatCOP(i.sales.total)}</td>
                  <td className="nx-num">{i.expected == null ? '—' : formatCOP(i.expected)}</td>
                  <td className="nx-num">{i.counted == null ? '—' : formatCOP(i.counted)}</td>
                  <td className={`nx-num${i.difference < 0 ? ' is-danger' : ''}`}>
                    {i.open ? '—' : i.difference ? `${i.difference < 0 ? '−' : '+'} ${formatCOP(Math.abs(i.difference))}` : formatCOP(0)}
                  </td>
                  <td>
                    {i.user.id !== user.id
                      ? <button type="button" className="nx-linkbtn" onClick={() => setAdjusting(i)}>Ajustar</button>
                      : <small className="nx-muted" title="Un ajuste de su propio turno lo autoriza otro administrador">Propio</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {adjusting && (
        <AdjustShift
          item={adjusting}
          onClose={(saved) => {
            setAdjusting(null);
            if (saved) load();
          }}
        />
      )}
    </>
  );
}

// datetime-local en hora del navegador (Colombia)
function toLocalInput(d) {
  if (!d) return '';
  const x = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

function AdjustShift({ item, onClose }) {
  const [start, setStart] = useState(toLocalInput(item.workedStart));
  const [end, setEnd] = useState(toLocalInput(item.workedEnd));
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet(`/admin/shifts/${item.shiftId}/adjustments`).then(setHistory).catch(() => {});
  }, [item.shiftId]);

  async function save() {
    setSaving(true);
    setError('');
    const body = { reason };
    if (start !== toLocalInput(item.workedStart)) body.workedStart = new Date(start).toISOString();
    if (!item.open && end !== toLocalInput(item.workedEnd)) body.workedEnd = new Date(end).toISOString();
    try {
      await apiPost(`/admin/shifts/${item.shiftId}/adjust`, body);
      onClose(true);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Ajustar turno · ${item.user.fullName}`}
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || reason.trim().length < 10}>Guardar ajuste</button>
        </>
      }
    >
      <p className="nx-muted nx-small">
        Turno real: {formatDateTime(item.openedAt)} → {item.closedAt ? formatDateTime(item.closedAt) : 'abierto'}
        <br />
        El ajuste cambia las horas trabajadas, no el turno ni su caja, y queda en auditoría.
      </p>
      <div className="nx-form__grid">
        <label className="nx-form__field"><span>Inicio trabajado</span><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="nx-form__field">
          <span>Fin trabajado</span>
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} disabled={item.open} />
          {item.open && <small className="nx-muted">El turno sigue abierto.</small>}
        </label>
      </div>
      <label className="nx-form__field">
        <span>Motivo (mínimo 10 caracteres)</span>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </label>
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
      {history.length > 0 && (
        <>
          <h3 className="nx-section-title">Ajustes anteriores</h3>
          <ul className="nx-plainlist">
            {history.map((a) => (
              <li key={a.id}>
                {formatDateTime(a.at)} · {a.authorizedBy}: {formatDateTime(a.previous.start)}–{a.previous.end ? formatDateTime(a.previous.end) : '…'} → {formatDateTime(a.next.start)}–{a.next.end ? formatDateTime(a.next.end) : '…'} · <em>{a.reason}</em>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
