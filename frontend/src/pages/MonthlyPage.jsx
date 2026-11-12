import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiDownload, apiGet, apiPatch, apiPost } from '../lib/api.js';
import { useWorkingSite } from '../context/ShiftContext.jsx';
import { useReceipt } from '../components/Receipt.jsx';
import Modal from '../components/Modal.jsx';
import Pager from '../components/Pager.jsx';
import PaymentFields, { paymentIsValid, paymentPayload } from '../components/PaymentFields.jsx';
import { formatCOP, formatDate, formatDateTime, todayIso } from '../lib/format.js';
import { detectVehicleType, normalizePlate, plateError, VEHICLE_LABELS } from '../lib/plates.js';

// Mensualidades (RF13-RF16): registro, pagos (único / quincenal / adelantado), importación CSV.
const dateOnly = (s) => (s ? formatDate(`${s}T12:00:00`) : '—');

const STATUS_TONE = {
  ACTIVE: 'ok',
  RENEWAL_ALLOWED: 'warn',
  DUE_TODAY: 'danger',
  OVERDUE: 'danger',
  PENDING_PAYMENT: 'warn',
  PENDING_CONFIRMATION: 'off',
  INSTALLMENT: 'info',
  INSTALLMENT_OVERDUE: 'danger',
  PREPAID: 'info',
};

export default function MonthlyPage() {
  const { siteId, sites, setSiteId } = useWorkingSite();
  const [filters, setFilters] = useState({ q: '', status: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [modal, setModal] = useState(null); // { kind, plan }
  const { showReceipt } = useReceipt();

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      const params = new URLSearchParams({ siteId, page, ...filters });
      setData(await apiGet(`/monthly?${params}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId, page, filters]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const close = (message) => {
    setModal(null);
    if (message) setFlash(message);
    load();
  };

  async function confirmImport(plan) {
    if (!window.confirm(`¿Confirmar que la mensualidad de ${plan.plate} (${plan.clientName}) ya está pagada? No pasa por caja.`)) return;
    try {
      await apiPost(`/monthly/${plan.id}/confirm-import`);
      close(`Pago de ${plan.plate} confirmado.`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(plan) {
    if (!window.confirm(`¿Eliminar la mensualidad de ${plan.plate} (${plan.clientName})? Sus pagos se conservan.`)) return;
    try {
      await apiDelete(`/monthly/${plan.id}`);
      close(`Mensualidad de ${plan.plate} eliminada.`);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="nx-stack">
      <section className="nx-card">
        <div className="nx-filters">
          {sites.length > 1 && (
            <label className="nx-form__field">
              <span>Sede</span>
              <select value={siteId ?? ''} onChange={(e) => { setPage(1); setSiteId(Number(e.target.value)); }}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="nx-form__field">
            <span>Buscar (placa, titular o teléfono)</span>
            <input value={filters.q} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, q: e.target.value })); }} />
          </label>
          <label className="nx-form__field">
            <span>Estado</span>
            <select value={filters.status} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, status: e.target.value })); }}>
              <option value="">Todas</option>
              <option value="active">Al día</option>
              <option value="soon">Por vencer (6 días)</option>
              <option value="overdue">Vencidas / en mora</option>
              <option value="pending">Pendientes de pago o confirmación</option>
            </select>
          </label>
          <div className="nx-filters__actions">
            <button type="button" className="nx-btn nx-btn--ghost" onClick={() => setModal({ kind: 'import' })}>
              Importar CSV
            </button>
            <button type="button" className="nx-btn nx-btn--accent" onClick={() => { setFlash(''); setModal({ kind: 'form' }); }}>
              + Nueva mensualidad
            </button>
          </div>
        </div>
      </section>

      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}
      {flash && <div className="nx-banner nx-banner--ok" role="status">{flash}</div>}

      {data && (
        <section className="nx-card">
          <div className="nx-table-wrap">
            <table className="nx-table">
              <thead>
                <tr>
                  <th>Placa</th>
                  <th>Titular</th>
                  <th>Modalidad</th>
                  <th>Período</th>
                  <th className="nx-num">Valor</th>
                  <th>Estado</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.plate}</strong> <span className="nx-muted">{m.vehicleLabel}</span>
                      {m.spaceLabel && <div className="nx-muted nx-small">Espacio {m.spaceLabel}</div>}
                    </td>
                    <td>
                      {m.clientName}
                      <div className="nx-muted nx-small">{m.phones.join(' · ')}</div>
                    </td>
                    <td>{m.schedule === 'NIGHT' ? `Noche ${m.nightStart}–${m.nightEnd}` : 'Día'}{m.isBiweekly ? ' · quincenal' : ''}</td>
                    <td>
                      {dateOnly(m.startDate)} – {dateOnly(m.endDate)}
                      {m.nextPeriod && <div className="nx-muted nx-small">Siguiente: hasta {dateOnly(m.nextPeriod.end)}</div>}
                      {m.installment && (
                        <div className="nx-muted nx-small">
                          Abonado {formatCOP(m.installment.paid)} · saldo {formatCOP(m.installment.balance)} · plazo {dateOnly(m.installment.dueDate)}
                        </div>
                      )}
                    </td>
                    <td className="nx-num">{formatCOP(m.amount)}</td>
                    <td>
                      <span className={`nx-badge nx-badge--${STATUS_TONE[m.status.code]}`}>{m.status.label}</span>
                    </td>
                    <td className="nx-actions">
                      {m.status.code === 'PENDING_CONFIRMATION' ? (
                        <button type="button" className="nx-btn nx-btn--accent nx-btn--sm" onClick={() => confirmImport(m)}>Confirmar pago</button>
                      ) : (
                        <>
                          {m.status.canPay && (
                            <button type="button" className="nx-btn nx-btn--accent nx-btn--sm" onClick={() => { setFlash(''); setModal({ kind: 'pay', plan: m }); }}>
                              {m.installment ? 'Pagar 2.º abono' : 'Pagar'}
                            </button>
                          )}
                          {m.status.canPrepay && (
                            <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => { setFlash(''); setModal({ kind: 'prepay', plan: m }); }}>
                              Adelantar
                            </button>
                          )}
                        </>
                      )}
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setModal({ kind: 'history', plan: m })}>Historial</button>
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setModal({ kind: 'form', plan: m })}>Editar</button>
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--danger-text" onClick={() => remove(m)}>Eliminar</button>
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr><td colSpan={7} className="nx-muted">No hay mensualidades con estos filtros.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} count={data.count} onChange={setPage} />
        </section>
      )}

      {modal?.kind === 'form' && <PlanForm siteId={siteId} plan={modal.plan} onClose={close} />}
      {(modal?.kind === 'pay' || modal?.kind === 'prepay') && (
        <PayModal plan={modal.plan} prepay={modal.kind === 'prepay'} onClose={close} onReceipt={showReceipt} />
      )}
      {modal?.kind === 'import' && <ImportModal siteId={siteId} onClose={close} />}
      {modal?.kind === 'history' && <HistoryModal plan={modal.plan} onClose={() => setModal(null)} onReceipt={showReceipt} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function PlanForm({ siteId, plan, onClose }) {
  const editing = Boolean(plan);
  const [f, setF] = useState(() => ({
    plate: plan?.plate ?? '',
    clientName: plan?.clientName ?? '',
    phones: plan?.phones?.length ? plan.phones : [''],
    email: plan?.email ?? '',
    spaceLabel: plan?.spaceLabel ?? '',
    schedule: plan?.schedule ?? 'DAY',
    nightStart: plan?.nightStart ?? '19:00',
    nightEnd: plan?.nightEnd ?? '07:00',
    startDate: plan?.startDate ?? todayIso(),
    endDate: plan?.endDate ?? '',
    amount: plan ? String(plan.amount) : '',
    isBiweekly: plan?.isBiweekly ?? false,
    dataConsent: plan?.dataConsent ?? false,
    notes: plan?.notes ?? '',
  }));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    setSaving(true);
    setError('');
    setErrors({});
    const body = {
      plate: f.plate,
      vehicleType: detectVehicleType(f.plate) ?? undefined,
      clientName: f.clientName,
      phones: f.phones.filter((p) => p.trim()),
      email: f.email,
      spaceLabel: f.spaceLabel,
      schedule: f.schedule,
      nightStart: f.nightStart,
      nightEnd: f.nightEnd,
      startDate: f.startDate || undefined,
      endDate: f.endDate || undefined,
      amount: f.amount ? Number(f.amount) : undefined,
      isBiweekly: f.isBiweekly,
      notes: f.notes,
    };
    try {
      if (editing) await apiPatch(`/monthly/${plan.id}`, body);
      else await apiPost('/monthly', { ...body, siteId, dataConsent: f.dataConsent });
      onClose(editing ? `Mensualidad de ${normalizePlate(f.plate)} actualizada.` : `Mensualidad de ${normalizePlate(f.plate)} registrada (pendiente de pago).`);
    } catch (err) {
      setError(err.message);
      setErrors(err.details && typeof err.details === 'object' ? err.details : {});
    } finally {
      setSaving(false);
    }
  }

  const plateErr = f.plate && plateError(f.plate);

  return (
    <Modal
      wide
      busy={saving}
      title={editing ? `Editar mensualidad · ${plan.plate}` : 'Nueva mensualidad'}
      onClose={() => onClose()}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose()} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || (!editing && !f.dataConsent)}>
            {saving ? 'Guardando…' : editing ? 'Guardar cambios' : 'Registrar'}
          </button>
        </>
      }
    >
      <div className="nx-form__grid">
        <label className="nx-form__field">
          <span>Placa</span>
          <input value={f.plate} onChange={(e) => setF((x) => ({ ...x, plate: e.target.value.toUpperCase().slice(0, 7) }))} aria-invalid={Boolean(plateErr || errors.plate)} />
          {(plateErr || errors.plate) && f.plate.length > 4 && <small className="nx-form__error">{errors.plate || plateErr}</small>}
          {!plateErr && f.plate && <small className="nx-muted">{VEHICLE_LABELS[detectVehicleType(f.plate)]}</small>}
        </label>
        <label className="nx-form__field">
          <span>Titular</span>
          <input value={f.clientName} onChange={set('clientName')} maxLength={60} aria-invalid={Boolean(errors.clientName)} />
          {errors.clientName && <small className="nx-form__error">{errors.clientName}</small>}
        </label>
        <label className="nx-form__field">
          <span>Correo (opcional)</span>
          <input type="email" value={f.email} onChange={set('email')} aria-invalid={Boolean(errors.email)} />
        </label>
        <label className="nx-form__field">
          <span>Espacio (opcional)</span>
          <input value={f.spaceLabel} onChange={set('spaceLabel')} maxLength={20} />
        </label>
      </div>

      <fieldset className="nx-form__fieldset">
        <legend>Teléfonos</legend>
        <div className="nx-form__grid">
          {f.phones.map((p, i) => (
            <label key={i} className="nx-form__field">
              <span className="nx-sr-only">Teléfono {i + 1}</span>
              <input
                inputMode="numeric"
                value={p}
                placeholder="3001234567"
                onChange={(e) => setF((x) => ({ ...x, phones: x.phones.map((q, j) => (j === i ? e.target.value.replace(/\D/g, '').slice(0, 10) : q)) }))}
              />
            </label>
          ))}
        </div>
        {errors.phones && <small className="nx-form__error">{errors.phones}</small>}
        <button type="button" className="nx-linkbtn" onClick={() => setF((x) => ({ ...x, phones: [...x.phones, ''] }))}>+ Agregar otro número</button>
      </fieldset>

      <div className="nx-form__grid">
        <label className="nx-form__field">
          <span>Modalidad</span>
          <select value={f.schedule} onChange={set('schedule')}>
            <option value="DAY">Día (bloquea cualquier entrada normal)</option>
            <option value="NIGHT">Noche (solo dentro de su franja)</option>
          </select>
        </label>
        {f.schedule === 'NIGHT' && (
          <>
            <label className="nx-form__field">
              <span>Hora límite de entrada</span>
              <input type="time" value={f.nightStart} onChange={set('nightStart')} />
            </label>
            <label className="nx-form__field">
              <span>Hora límite de salida</span>
              <input type="time" value={f.nightEnd} onChange={set('nightEnd')} />
            </label>
          </>
        )}
        <label className="nx-form__field">
          <span>Inicio</span>
          <input type="date" value={f.startDate} onChange={set('startDate')} />
        </label>
        <label className="nx-form__field">
          <span>Vence (vacío = un mes)</span>
          <input type="date" value={f.endDate} onChange={set('endDate')} />
        </label>
        <label className="nx-form__field">
          <span>Valor mensual (vacío = tarifa)</span>
          <input inputMode="numeric" value={f.amount} onChange={(e) => setF((x) => ({ ...x, amount: e.target.value.replace(/\D/g, '') }))} />
        </label>
      </div>
      <label className="nx-check">
        <input type="checkbox" checked={f.isBiweekly} onChange={set('isBiweekly')} />
        <span>Pago quincenal (2 abonos)</span>
      </label>
      <label className="nx-form__field">
        <span>Observaciones (opcional)</span>
        <input value={f.notes} onChange={set('notes')} maxLength={300} />
      </label>
      {!editing && (
        <label className="nx-check nx-consent">
          <input type="checkbox" checked={f.dataConsent} onChange={set('dataConsent')} />
          <span>
            El titular autoriza el tratamiento de sus datos personales (nombre, teléfono, correo y placa) para la
            prestación del servicio de mensualidad, conforme a la Ley 1581 de 2012.
          </span>
        </label>
      )}
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function PayModal({ plan, prepay, onClose, onReceipt }) {
  const biweekly = plan.isBiweekly && !prepay;
  const balance = plan.installment ? plan.installment.balance : plan.amount;
  const [installment, setInstallment] = useState(String(plan.installment ? balance : Math.round(plan.amount / 2)));
  const base = biweekly ? Number(installment) || 0 : plan.amount;
  const [pay, setPay] = useState({ charged: '', reason: '', method: 'CASH', cash: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const body = { ...paymentPayload(pay, base) };
      if (biweekly) body.installmentAmount = base;
      const r = await apiPost(`/monthly/${plan.id}/${prepay ? 'prepay' : 'pay'}`, body);
      onReceipt(r.receipt);
      onClose(
        prepay
          ? `Pago adelantado de ${plan.plate} registrado (${r.receipt.receipt}). El nuevo período arranca solo el ${dateOnly(r.plan.nextPeriod.start)}.`
          : r.isFinal
            ? `Pago de ${plan.plate} registrado (${r.receipt.receipt}). Vigente hasta ${dateOnly(r.plan.endDate)}.`
            : `Primer abono de ${plan.plate} registrado (${r.receipt.receipt}). Saldo: ${formatCOP(r.balance)}.`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const title = prepay ? 'Pago adelantado' : biweekly ? `Pago quincenal (${plan.installment ? '2/2' : '1/2'})` : 'Pagar mensualidad';
  const valid = paymentIsValid(pay, base) && base > 0 && (!biweekly || base <= balance);

  return (
    <Modal
      title={`${title} · ${plan.plate}`}
      busy={saving}
      onClose={() => onClose()}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose()} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || !valid}>
            {saving ? 'Guardando…' : 'Registrar pago'}
          </button>
        </>
      }
    >
      <p className="nx-muted">
        {plan.clientName} · valor mensual {formatCOP(plan.amount)}
        {plan.status.moraDays > 0 && <> · <strong className="is-danger">en mora {plan.status.moraDays} días</strong></>}
        {prepay && <> · el período actual sigue vigente hasta {dateOnly(plan.endDate)}</>}
      </p>
      {biweekly && (
        <label className="nx-form__field">
          <span>Abono ahora (saldo {formatCOP(balance)})</span>
          <input inputMode="numeric" value={installment} onChange={(e) => setInstallment(e.target.value.replace(/\D/g, ''))} />
        </label>
      )}
      <PaymentFields value={pay} onChange={setPay} base={base} />
      <p className="nx-muted nx-small">Los pagos de mensualidad no pasan por la caja; tienen su propio consecutivo (FM).</p>
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function ImportModal({ siteId, onClose }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function upload() {
    setSaving(true);
    setError('');
    try {
      const csv = await file.text();
      setResult(await apiPost('/monthly/import', { siteId, csv }));
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
      title="Importar mensualidades (CSV)"
      onClose={() => onClose(result?.imported ? `${result.imported} mensualidades importadas: confírmelas una a una.` : undefined)}
      actions={
        result ? (
          <button type="button" className="nx-btn nx-btn--accent" onClick={() => onClose(`${result.imported} mensualidades importadas: confírmelas una a una.`)}>
            Listo
          </button>
        ) : (
          <>
            <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose()} disabled={saving}>Cancelar</button>
            <button type="button" className="nx-btn nx-btn--accent" onClick={upload} disabled={!file || saving}>
              {saving ? 'Importando…' : 'Importar'}
            </button>
          </>
        )
      }
    >
      <p className="nx-muted">
        Las filas válidas entran como <strong>pendientes de confirmar pago</strong> (no pasan por caja). Las filas con
        error no se cargan y se listan con el motivo.
      </p>
      <button type="button" className="nx-linkbtn" onClick={() => apiDownload('/monthly/import/template', 'plantilla_mensualidades.csv')}>
        Descargar plantilla
      </button>
      {!result && <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
      {result && (
        <>
          <p className="nx-banner nx-banner--ok">{result.imported} de {result.total} filas importadas.</p>
          {result.errors.length > 0 && (
            <div className="nx-table-wrap">
              <table className="nx-table">
                <thead><tr><th>Línea</th><th>Placa</th><th>Motivo</th></tr></thead>
                <tbody>
                  {result.errors.map((e) => (
                    <tr key={`${e.line}-${e.plate}`}><td>{e.line}</td><td>{e.plate || '—'}</td><td>{e.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function HistoryModal({ plan, onClose, onReceipt }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet(`/monthly/${plan.id}`).then(setDetail).catch((err) => setError(err.message));
  }, [plan.id]);

  async function reprint(p) {
    try {
      onReceipt(await apiGet(`/monthly/payments/${p.id}/receipt`));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal wide title={`Pagos · ${plan.plate} · ${plan.clientName}`} onClose={onClose}
      actions={<button type="button" className="nx-btn nx-btn--ghost" onClick={onClose}>Cerrar</button>}>
      {error && <p className="nx-form__alert">{error}</p>}
      {!detail ? (
        <p className="nx-muted">Cargando…</p>
      ) : detail.payments.length === 0 ? (
        <p className="nx-muted">Todavía no tiene pagos.</p>
      ) : (
        <div className="nx-table-wrap">
          <table className="nx-table">
            <thead>
              <tr><th>Recibo</th><th>Período</th><th className="nx-num">Valor</th><th>Forma</th><th>Fecha</th><th aria-label="Acciones" /></tr>
            </thead>
            <tbody>
              {detail.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.receipt}{p.installmentNumber ? ` (abono ${p.installmentNumber})` : ''}{p.isAdvance ? ' · adelanto' : ''}</td>
                  <td>{dateOnly(p.periodStart)} – {dateOnly(p.periodEnd)}</td>
                  <td className="nx-num">{formatCOP(p.amount)}</td>
                  <td>{p.paymentLabel}</td>
                  <td>{formatDateTime(p.paidAt)}</td>
                  <td><button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => reprint(p)}>Imprimir</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
