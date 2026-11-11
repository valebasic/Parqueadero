import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { useShift } from '../context/ShiftContext.jsx';
import { formatCOP, formatDateTime } from '../lib/format.js';
import CashCount, { cashCountTotal, cleanCashCount } from '../components/CashCount.jsx';
import Modal from '../components/Modal.jsx';

// Cierre de caja / turno (RF41-RF43): abrir turno con la base contada, entregarlo a otro usuario
// (arqueo + contraseña de ambos) o cerrarlo sin relevo. La caja completa (movimientos, reporte de
// cierre) se amplía en la Fase 5.
export default function CashPage() {
  const { shift, loading, refresh } = useShift();
  const [result, setResult] = useState(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) return <p className="nx-muted">Cargando turno…</p>;

  return (
    <div className="nx-stack">
      {result && <CloseResult result={result} onDismiss={() => setResult(null)} />}
      {shift ? (
        <OpenShiftPanel shift={shift} onClosed={(r) => { setResult(r); refresh(); }} onRefresh={refresh} />
      ) : (
        <OpenShiftForm onOpened={() => { setResult(null); refresh(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function OpenShiftForm({ onOpened }) {
  const { user } = useSession();
  const [siteId, setSiteId] = useState(user.sites[0]?.id ?? null);
  const [zones, setZones] = useState([]);
  const [busyZones, setBusyZones] = useState({});
  const [zoneId, setZoneId] = useState('');
  const [count, setCount] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    Promise.all([apiGet(`/sites/${siteId}`), apiGet(`/shifts/open?siteId=${siteId}`)])
      .then(([site, open]) => {
        if (cancelled) return;
        const active = site.zones.filter((z) => z.isActive);
        const busy = Object.fromEntries(open.map((s) => [s.zone.id, s.user.fullName]));
        setZones(active);
        setBusyZones(busy);
        setZoneId(String(active.find((z) => !busy[z.id])?.id ?? ''));
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await apiPost('/shifts', { zoneId: Number(zoneId), denominations: cleanCashCount(count) });
      onOpened();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="nx-card">
      <header className="nx-card__header">
        <div>
          <h2 className="nx-card__title">Abrir turno</h2>
          <p className="nx-muted nx-card__subtitle">
            Sin turno abierto no se pueden registrar entradas, salidas ni cobros. Cuente la base del cajón.
          </p>
        </div>
      </header>
      <form className="nx-form" onSubmit={submit}>
        <div className="nx-form__grid">
          {user.sites.length > 1 && (
            <label className="nx-form__field">
              <span>Sede</span>
              <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
                {user.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="nx-form__field">
            <span>Zona</span>
            <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} required>
              <option value="">Seleccione la zona</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id} disabled={Boolean(busyZones[z.id])}>
                  {z.name}
                  {busyZones[z.id] ? ` — turno abierto de ${busyZones[z.id]}` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="nx-form__fieldset">
          <legend>Base contada</legend>
          <CashCount value={count} onChange={setCount} />
        </fieldset>
        {error && (
          <p className="nx-form__alert" role="alert">
            {error}
          </p>
        )}
        <div className="nx-form__actions">
          <button type="submit" className="nx-btn nx-btn--accent" disabled={saving || !zoneId}>
            {saving ? 'Abriendo…' : `Abrir turno con base de ${formatCOP(cashCountTotal(count))}`}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
function Stat({ label, value, tone }) {
  return (
    <div className={`nx-stat${tone ? ` nx-stat--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OpenShiftPanel({ shift, onClosed, onRefresh }) {
  const [mode, setMode] = useState(null); // 'handover' | 'close'
  const s = shift.summary;

  return (
    <>
      <section className="nx-card">
        <header className="nx-card__header">
          <div>
            <h2 className="nx-card__title">
              Turno de {shift.user.fullName} · {shift.zone.name}
            </h2>
            <p className="nx-muted nx-card__subtitle">
              {shift.site.name} · abierto el {formatDateTime(shift.openedAt)}
            </p>
          </div>
          <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onRefresh}>
            Actualizar
          </button>
        </header>

        <div className="nx-stats">
          <Stat label="Base del día" value={formatCOP(s.baseFinal)} tone="base" />
          <Stat label="Ventas del turno" value={formatCOP(s.totalSales)} />
          <Stat label="Pagos electrónicos" value={formatCOP(s.electronicSales)} tone="info" />
          <Stat label="Efectivo esperado" value={formatCOP(s.expectedCash)} tone="ok" />
          <Stat label="Ingresos" value={formatCOP(s.incomes)} />
          <Stat label="Egresos" value={formatCOP(s.expenses)} />
          <Stat label="Descuentos" value={formatCOP(s.discounts)} tone="danger" />
          <Stat label="Debe haber en el cajón" value={formatCOP(s.expectedInDrawer)} tone="accent" />
        </div>
        <p className="nx-muted nx-small">
          Efectivo esperado = efectivo de ventas + ingresos − egresos. En el cajón debe haber además la base
          ({formatCOP(s.initialCash)} inicial{s.baseIn || s.baseOut ? `, +${formatCOP(s.baseIn)} / −${formatCOP(s.baseOut)}` : ''}).
          {' '}Ventas registradas: {s.salesCount}.
        </p>

        <div className="nx-form__actions">
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => setMode('close')}>
            Cerrar turno sin relevo
          </button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={() => setMode('handover')}>
            Entregar turno
          </button>
        </div>
      </section>

      {mode && (
        <CloseShiftModal
          shift={shift}
          handover={mode === 'handover'}
          onCancel={() => setMode(null)}
          onDone={(r) => {
            setMode(null);
            onClosed(r);
          }}
        />
      )}
    </>
  );
}

function CloseShiftModal({ shift, handover, onCancel, onDone }) {
  const [count, setCount] = useState({});
  const [notes, setNotes] = useState('');
  const [outgoingPassword, setOutgoingPassword] = useState('');
  const [incomingUsername, setIncomingUsername] = useState('');
  const [incomingPassword, setIncomingPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const counted = cashCountTotal(count);
  const expected = shift.summary.expectedInDrawer;
  const diff = counted - expected;

  async function submit() {
    setSaving(true);
    setError('');
    try {
      const denominations = cleanCashCount(count);
      const data = handover
        ? await apiPost(`/shifts/${shift.id}/handover`, {
            denominations,
            notes,
            outgoingPassword,
            incomingUsername: incomingUsername.trim(),
            incomingPassword,
          })
        : await apiPost(`/shifts/${shift.id}/close`, { denominations, notes });
      onDone({ ...data, handover });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      wide
      busy={saving}
      title={handover ? 'Entregar turno' : 'Cerrar turno sin relevo'}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
          <button
            type="button"
            className="nx-btn nx-btn--accent"
            onClick={submit}
            disabled={saving || (handover && (!outgoingPassword || !incomingUsername || !incomingPassword))}
          >
            {saving ? 'Guardando…' : handover ? 'Confirmar entrega' : 'Cerrar turno'}
          </button>
        </>
      }
    >
      <p className="nx-muted">
        Cuente todo el dinero del cajón. Debe haber <strong>{formatCOP(expected)}</strong>.
        {handover && ' Quien recibe queda con lo contado como base de su turno.'}
      </p>
      <CashCount value={count} onChange={setCount} disabled={saving} />
      <p className={`nx-diff ${diff === 0 ? 'is-ok' : diff > 0 ? 'is-over' : 'is-short'}`}>
        {diff === 0 ? 'Cuadra exacto' : diff > 0 ? `Sobrante de ${formatCOP(diff)}` : `Faltante de ${formatCOP(-diff)}`}
      </p>

      {handover && (
        <div className="nx-form__grid">
          <label className="nx-form__field">
            <span>Contraseña de quien entrega ({shift.user.username})</span>
            <input type="password" value={outgoingPassword} onChange={(e) => setOutgoingPassword(e.target.value)} autoComplete="off" />
          </label>
          <label className="nx-form__field">
            <span>Usuario que recibe</span>
            <input value={incomingUsername} onChange={(e) => setIncomingUsername(e.target.value)} autoComplete="off" />
          </label>
          <label className="nx-form__field">
            <span>Contraseña de quien recibe</span>
            <input type="password" value={incomingPassword} onChange={(e) => setIncomingPassword(e.target.value)} autoComplete="off" />
          </label>
        </div>
      )}
      <label className="nx-form__field">
        <span>Observaciones (opcional)</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
      </label>
      {error && (
        <p className="nx-form__alert" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

function CloseResult({ result, onDismiss }) {
  const d = result.difference;
  return (
    <section className={`nx-card nx-result ${d === 0 ? 'is-ok' : 'is-warn'}`} role="status">
      <header className="nx-card__header">
        <h2 className="nx-card__title">
          {result.handover ? `Turno entregado a ${result.receivedBy.fullName}` : 'Turno cerrado'}
        </h2>
        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onDismiss}>
          Entendido
        </button>
      </header>
      <div className="nx-stats">
        <Stat label="Debía haber" value={formatCOP(result.expectedInDrawer)} />
        <Stat label="Contado" value={formatCOP(result.counted)} />
        <Stat label="Diferencia" value={formatCOP(d)} tone={d === 0 ? 'ok' : 'danger'} />
      </div>
      {result.handover && (
        <p className="nx-muted">
          Para seguir operando, {result.receivedBy.fullName} debe iniciar sesión con su usuario ({result.receivedBy.username}).
        </p>
      )}
    </section>
  );
}
