import { Fragment, useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api.js';
import { useShift, useWorkingSite } from '../context/ShiftContext.jsx';
import Modal from '../components/Modal.jsx';
import { formatCOP, formatDate, formatTime12h, PAYMENT_LABELS } from '../lib/format.js';

// Pendientes (RF12): cobros de salidas que no se cobraron al salir, agrupados por mensualidad o
// placa. "Confirmar pago" los cobra en una caja abierta (la propia o la de un turno de la sede).
export default function PendingPage() {
  const { siteId, sites, setSiteId, lockedByShift } = useWorkingSite();
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      setGroups(await apiGet(`/pending-charges?siteId=${siteId}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="nx-stack">
      {!lockedByShift && sites.length > 1 && (
        <section className="nx-card">
          <label className="nx-form__field nx-form__field--inline">
            <span>Sede</span>
            <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}
      {error && <div className="nx-banner nx-banner--error">{error}</div>}
      {flash && <div className="nx-banner nx-banner--ok">{flash}</div>}

      <section className="nx-card">
        <header className="nx-card__header">
          <div>
            <h2 className="nx-card__title">Cobros pendientes</h2>
            <p className="nx-muted nx-card__subtitle">
              Salidas de mensualidades fuera de horario o registradas como "Pendiente". Al confirmar, la venta entra a la caja elegida.
            </p>
          </div>
        </header>
        {!groups ? (
          <p className="nx-muted">Cargando…</p>
        ) : groups.length === 0 ? (
          <p className="nx-muted">No hay cobros pendientes.</p>
        ) : (
          <div className="nx-table-wrap">
            <table className="nx-table">
              <thead>
                <tr>
                  <th>Placa</th>
                  <th>Cliente</th>
                  <th>Salidas</th>
                  <th>Última salida</th>
                  <th className="nx-num">Total</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.key}>
                    <tr>
                      <td>
                        <strong>{g.plate}</strong> <span className="nx-muted">{g.vehicleLabel}</span>
                      </td>
                      <td>{g.clientName || '—'}</td>
                      <td>{g.charges.length}</td>
                      <td>
                        {formatDate(g.lastExitAt)} {formatTime12h(g.lastExitAt)}
                      </td>
                      <td className="nx-num">
                        <strong>{formatCOP(g.total)}</strong>
                      </td>
                      <td className="nx-actions">
                        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setExpanded(expanded === g.key ? null : g.key)}>
                          Historial
                        </button>
                        <button type="button" className="nx-btn nx-btn--accent nx-btn--sm" onClick={() => { setFlash(''); setConfirming(g); }}>
                          Confirmar pago
                        </button>
                      </td>
                    </tr>
                    {expanded === g.key && (
                      <tr className="nx-subrow">
                        <td colSpan={6}>
                          <table className="nx-table nx-table--inner">
                            <thead>
                              <tr>
                                <th>Recibo</th>
                                <th>Entrada</th>
                                <th>Salida</th>
                                <th>Motivo</th>
                                <th className="nx-num">Valor</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.charges.map((c) => (
                                <tr key={c.id}>
                                  <td>{c.receipt}</td>
                                  <td>{formatDate(c.entryAt)} {formatTime12h(c.entryAt)}</td>
                                  <td>{formatDate(c.exitAt)} {formatTime12h(c.exitAt)}</td>
                                  <td>{c.reason === 'OUT_OF_SCHEDULE' ? 'Fuera de horario' : 'Pendiente'}</td>
                                  <td className="nx-num">{formatCOP(c.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirming && (
        <ConfirmModal
          group={confirming}
          siteId={siteId}
          onCancel={() => setConfirming(null)}
          onDone={(r) => {
            setConfirming(null);
            setFlash(`Pago de ${confirming.plate} confirmado: ${formatCOP(r.charged)}.`);
            load();
          }}
        />
      )}
    </div>
  );
}

function ConfirmModal({ group, siteId, onCancel, onDone }) {
  const { shift } = useShift();
  const [openShifts, setOpenShifts] = useState([]);
  const [shiftId, setShiftId] = useState(shift?.id ? String(shift.id) : '');
  const [method, setMethod] = useState('CASH');
  const [charged, setCharged] = useState(String(group.total));
  const [reason, setReason] = useState('');
  const [cash, setCash] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet(`/shifts/open?siteId=${siteId}`)
      .then((list) => {
        setOpenShifts(list);
        if (!shift && list[0]) setShiftId(String(list[0].id));
      })
      .catch(() => {});
  }, [siteId, shift]);

  const total = Number(charged) || 0;
  const discount = Math.max(0, group.total - total);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const r = await apiPost('/pending-charges/confirm', {
        chargeIds: group.charges.map((c) => c.id),
        paymentMethod: method,
        cashAmount: method === 'MIXED' ? Number(cash) : undefined,
        chargedAmount: total,
        discountReason: reason,
        shiftId: shiftId ? Number(shiftId) : undefined,
      });
      onDone(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Confirmar pago · ${group.plate}`}
      onClose={onCancel}
      busy={saving}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
          <button
            type="button"
            className="nx-btn nx-btn--accent"
            onClick={save}
            disabled={saving || !shiftId || total > group.total || (discount > 0 && reason.trim().length < 3)}
          >
            {saving ? 'Guardando…' : `Confirmar ${formatCOP(total)}`}
          </button>
        </>
      }
    >
      <label className="nx-form__field">
        <span>Caja donde entra el pago</span>
        <select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
          <option value="">{openShifts.length ? 'Seleccione el turno' : 'No hay turnos abiertos en la sede'}</option>
          {openShifts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.zone.name} · {s.user.fullName}
              {shift?.id === s.id ? ' (su turno)' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="nx-form__grid nx-form__grid--2">
        <label className="nx-form__field">
          <span>Valor a cobrar (de {formatCOP(group.total)})</span>
          <input inputMode="numeric" value={charged} onChange={(e) => setCharged(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="nx-form__field">
          <span>Motivo del descuento{discount > 0 ? ' (obligatorio)' : ''}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} disabled={discount === 0} />
        </label>
      </div>
      <div className="nx-paymethods">
        {['CASH', 'ELECTRONIC', 'MIXED'].map((m) => (
          <button key={m} type="button" className={`nx-paymethod${method === m ? ' is-active' : ''}`} onClick={() => setMethod(m)}>
            {PAYMENT_LABELS[m]}
          </button>
        ))}
      </div>
      {method === 'MIXED' && (
        <label className="nx-form__field">
          <span>Efectivo (el resto, electrónico)</span>
          <input inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value.replace(/\D/g, ''))} />
        </label>
      )}
      {error && (
        <p className="nx-form__alert" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
