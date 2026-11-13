import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { useShift, useWorkingSite } from '../context/ShiftContext.jsx';
import { useSiteEvents } from '../context/RealtimeContext.jsx';
import { formatCOP, formatDate, formatTime12h } from '../lib/format.js';

// Inicio. AG y AS: tablero de la sede (se actualiza cada minuto). OP: accesos rápidos de su turno.
export default function DashboardPage() {
  const { user } = useSession();
  return user.role === 'OP' ? <OperatorHome /> : <AdminDashboard />;
}

function OperatorHome() {
  const { user } = useSession();
  const { shift } = useShift();
  return (
    <section className="nx-card">
      <h2 className="nx-card__title">Hola, {user.fullName}</h2>
      {shift ? (
        <p>
          Turno abierto en <strong>{shift.zone.name}</strong> desde {formatTime12h(shift.openedAt)} · ventas{' '}
          {formatCOP(shift.summary.totalSales)}.
        </p>
      ) : (
        <p className="nx-muted">No tiene turno abierto.</p>
      )}
      <div className="nx-form__actions nx-form__actions--start">
        <Link className="nx-btn nx-btn--accent" to="/entradas">Ir a Entradas</Link>
        <Link className="nx-btn nx-btn--ghost" to="/caja">{shift ? 'Ver turno y caja' : 'Abrir turno'}</Link>
      </div>
    </section>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <div className={`nx-stat${tone ? ` nx-stat--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small className="nx-muted">{sub}</small>}
    </div>
  );
}

// Botón de sobre: envía a mano el aviso de mensualidad por correo (aparte de los automáticos)
function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

function RemindButton({ alert, state, onSend }) {
  const sending = state === 'sending';
  const sent = state === 'sent';
  const title = !alert.canNotify
    ? `No se puede avisar: ${alert.notifyReason.toLowerCase()}`
    : sent
      ? 'Aviso enviado'
      : 'Enviar aviso por correo ahora';
  return (
    <button
      type="button"
      className={`nx-alert-item__mail${sent ? ' is-sent' : ''}`}
      onClick={() => onSend(alert)}
      disabled={!alert.canNotify || sending}
      title={title}
      aria-label={`${title} a ${alert.clientName} (${alert.plate})`}
    >
      {sending ? '…' : sent ? '✔' : <MailIcon />}
    </button>
  );
}

function AdminDashboard() {
  const { siteId, sites, setSiteId } = useWorkingSite();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [remind, setRemind] = useState({}); // id de la mensualidad -> 'sending' | 'sent'
  const [remindMsg, setRemindMsg] = useState(null); // { ok, text }

  async function sendReminder(a) {
    if (!window.confirm(`¿Enviar ahora el aviso por correo a ${a.clientName} (${a.plate})?`)) return;
    setRemind((r) => ({ ...r, [a.id]: 'sending' }));
    setRemindMsg(null);
    try {
      const r = await apiPost(`/monthly/${a.id}/remind`, {});
      setRemind((x) => ({ ...x, [a.id]: 'sent' }));
      setRemindMsg({ ok: true, text: `Aviso enviado a ${a.clientName} (${r.to}).` });
    } catch (err) {
      setRemind((x) => ({ ...x, [a.id]: undefined }));
      setRemindMsg({ ok: false, text: err.message });
    }
  }

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      setData(await apiGet(`/reports/dashboard?siteId=${siteId}`, { background: true }));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId]);

  // Tiempo real: cualquier evento de la sede (entradas, salidas, caja, turnos, mensualidades)
  useSiteEvents(siteId, null, () => load());

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <div className="nx-banner nx-banner--error">{error}</div>;
  if (!data) return <p className="nx-muted">Cargando…</p>;
  const maxHour = Math.max(1, ...data.entriesByHour.map((h) => h.count));

  return (
    <div className="nx-stack">
      {sites.length > 1 && (
        <section className="nx-card">
          <label className="nx-form__field nx-form__field--inline">
            <span>Sede</span>
            <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </section>
      )}

      <section className="nx-card">
        <div className="nx-stats">
          <Kpi label="Vehículos dentro" value={data.inside.total} sub={data.inside.byType.map((t) => `${t.label} ${t.count}`).join(' · ')} tone="accent" />
          <Kpi
            label="Ocupación"
            value={data.inside.occupancy == null ? '—' : `${data.inside.occupancy} %`}
            sub={data.inside.capacity ? `de ${data.inside.capacity} cupos` : 'Sin capacidad configurada'}
          />
          <Kpi label="Entradas hoy" value={data.today.entries} />
          <Kpi label="Salidas hoy" value={data.today.exits} />
          <Kpi label="Ventas hoy" value={formatCOP(data.sales.total)} sub={`${data.sales.count} ventas`} tone="ok" />
          <Kpi label="Efectivo" value={formatCOP(data.sales.cash)} />
          <Kpi label="Electrónico" value={formatCOP(data.sales.electronic)} tone="info" />
          <Kpi label="Pendientes" value={formatCOP(data.pending.total)} sub={`${data.pending.count} cobros`} tone={data.pending.count ? 'danger' : undefined} />
        </div>
        {data.inside.capacity ? (
          <div className="nx-occupancy" role="meter" aria-valuenow={data.inside.occupancy} aria-valuemin={0} aria-valuemax={100} aria-label="Ocupación">
            <span style={{ width: `${Math.min(100, data.inside.occupancy)}%` }} />
          </div>
        ) : null}
      </section>

      <div className="nx-grid-2">
        <section className="nx-card">
          <h2 className="nx-card__title nx-card__title--spaced">Mensualidades por vencer / en mora</h2>
          {data.monthlyAlerts.length === 0 ? (
            <p className="nx-muted">Ninguna vence en los próximos 6 días.</p>
          ) : (
            <ul className="nx-alerts">
              {data.monthlyAlerts.map((a) => (
                <li key={a.id} className={`nx-alert-item is-${a.color}`}>
                  <span className="nx-alert-item__dot" aria-hidden="true" />
                  <strong>{a.plate}</strong>
                  <span>{a.clientName}</span>
                  <span className="nx-alert-item__label">{a.label}</span>
                  <RemindButton alert={a} state={remind[a.id]} onSend={sendReminder} />
                </li>
              ))}
            </ul>
          )}
          {remindMsg && (
            <p className={`nx-alert-feedback${remindMsg.ok ? ' is-ok' : ' is-error'}`} role="status">
              {remindMsg.text}
            </p>
          )}
          <p className="nx-muted nx-small">Rojo: en mora o vence hoy · Amarillo: 1 a 3 días · Verde: 4 a 6 días.</p>
        </section>

        <section className="nx-card">
          <h2 className="nx-card__title nx-card__title--spaced">Entradas por hora (hoy)</h2>
          <div className="nx-hourbars" role="img" aria-label="Entradas por hora de hoy">
            {data.entriesByHour.map((h) => (
              <div key={h.hour} className="nx-hourbars__col" title={`${formatTime12h(new Date(2026, 0, 1, h.hour))}: ${h.count} entradas`}>
                <span style={{ height: `${(h.count / maxHour) * 100}%` }} />
                {h.hour % 3 === 0 && <small>{h.hour}</small>}
              </div>
            ))}
          </div>
          <h3 className="nx-section-title">Turnos abiertos</h3>
          {data.openShifts.length === 0 ? (
            <p className="nx-muted">No hay turnos abiertos.</p>
          ) : (
            <ul className="nx-plainlist">
              {data.openShifts.map((s) => (
                <li key={s.id}><strong>{s.zone}</strong> · {s.user} · desde {formatDate(s.openedAt)} {formatTime12h(s.openedAt)}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
