import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { useShift, useWorkingSite } from '../context/ShiftContext.jsx';
import Modal from '../components/Modal.jsx';
import Pager from '../components/Pager.jsx';
import { formatCOP, formatDateTime, todayIso } from '../lib/format.js';

// Transacciones (RF18): ingresos (verde), egresos (rojo) y movimientos de base (naranja) en una tabla.
// Editar solo el mismo día. El OP registra ingresos y egresos de su caja (egresos con tope).
const TYPES = [
  { id: 'INCOME', label: 'Ingreso', tone: 'income', sign: '+' },
  { id: 'EXPENSE', label: 'Egreso', tone: 'expense', sign: '−' },
  { id: 'BASE_IN', label: 'Agregar a la base', tone: 'base', sign: '+', admin: true },
  { id: 'BASE_OUT', label: 'Quitar de la base', tone: 'base', sign: '−', admin: true },
];
const typeInfo = (id) => TYPES.find((t) => t.id === id);

export default function TransactionsPage() {
  const { user } = useSession();
  const { shift, refresh: refreshShift } = useShift();
  const { siteId, sites, setSiteId, lockedByShift } = useWorkingSite();
  const [range, setRange] = useState({ from: todayIso(), to: todayIso() });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // 'new' | movimiento

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      setData(await apiGet(`/cash-movements?${new URLSearchParams({ siteId, page, ...range })}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId, page, range]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(m) {
    if (!window.confirm(`¿Eliminar el ${m.typeLabel.toLowerCase()} de ${formatCOP(m.amount)}?`)) return;
    try {
      await apiDelete(`/cash-movements/${m.id}`);
      load();
      refreshShift();
    } catch (err) {
      setError(err.message);
    }
  }

  const isAdmin = user.role !== 'OP';

  return (
    <div className="nx-stack">
      <section className="nx-card">
        <div className="nx-filters">
          <div className="nx-stat nx-stat--base">
            <span>Base actual</span>
            <strong>{shift ? formatCOP(shift.summary.baseFinal) : '—'}</strong>
          </div>
          {!lockedByShift && sites.length > 1 && (
            <label className="nx-form__field">
              <span>Sede</span>
              <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label className="nx-form__field">
            <span>Desde</span>
            <input type="date" value={range.from} onChange={(e) => { setPage(1); setRange((r) => ({ ...r, from: e.target.value })); }} />
          </label>
          <label className="nx-form__field">
            <span>Hasta</span>
            <input type="date" value={range.to} onChange={(e) => { setPage(1); setRange((r) => ({ ...r, to: e.target.value })); }} />
          </label>
          <div className="nx-filters__actions">
            <button type="button" className="nx-btn nx-btn--accent" onClick={() => setEditing('new')} disabled={!shift && !isAdmin}>
              + Registrar nuevo movimiento
            </button>
          </div>
        </div>
        {!shift && <p className="nx-muted nx-small">Sin turno abierto: {isAdmin ? 'elija el turno de la caja al registrar.' : 'abra un turno para registrar movimientos.'}</p>}
      </section>

      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}

      {data && (
        <section className="nx-card">
          <h2 className="nx-card__title nx-card__title--spaced">Movimientos</h2>
          <div className="nx-table-wrap">
            <table className="nx-table">
              <thead>
                <tr><th>Tipo</th><th>Concepto</th><th className="nx-num">Valor</th><th>Zona</th><th>Registró</th><th>Fecha</th><th aria-label="Acciones" /></tr>
              </thead>
              <tbody>
                {data.items.map((m) => {
                  const t = typeInfo(m.type);
                  return (
                    <tr key={m.id}>
                      <td><span className={`nx-mov nx-mov--${t.tone}`}>{m.typeLabel}</span></td>
                      <td>{m.withdrawalTo ? `Retiro entregado a ${m.withdrawalTo}` : m.concept || '—'}</td>
                      <td className={`nx-num nx-mov-value nx-mov-value--${t.tone}`}>{t.sign}{formatCOP(m.amount)}</td>
                      <td>{m.zone}</td>
                      <td>{m.createdBy}</td>
                      <td>{formatDateTime(m.createdAt)}</td>
                      <td className="nx-actions">
                        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" disabled={!m.canEdit} title={m.canEdit ? '' : 'Solo el mismo día, en movimientos que puede modificar'} onClick={() => setEditing(m)}>Editar</button>
                        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--danger-text" disabled={!m.canDelete} onClick={() => remove(m)}>Eliminar</button>
                      </td>
                    </tr>
                  );
                })}
                {data.items.length === 0 && <tr><td colSpan={7} className="nx-muted">No hay movimientos en estas fechas.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} count={data.count} onChange={setPage} />
        </section>
      )}

      {editing && (
        <MovementModal
          movement={editing === 'new' ? null : editing}
          isAdmin={isAdmin}
          siteId={siteId}
          shift={shift}
          onClose={(changed) => {
            setEditing(null);
            if (changed) {
              load();
              refreshShift();
            }
          }}
        />
      )}
    </div>
  );
}

function MovementModal({ movement, isAdmin, siteId, shift, onClose }) {
  const [type, setType] = useState(movement?.type ?? '');
  const [amount, setAmount] = useState(movement ? String(movement.amount) : '');
  const [concept, setConcept] = useState(movement?.concept ?? '');
  const [openShifts, setOpenShifts] = useState([]);
  const [shiftId, setShiftId] = useState(shift ? String(shift.id) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!movement && isAdmin && !shift) {
      apiGet(`/shifts/open?siteId=${siteId}`).then((l) => { setOpenShifts(l); if (l[0]) setShiftId(String(l[0].id)); }).catch(() => {});
    }
  }, [movement, isAdmin, shift, siteId]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const body = { type, amount: Number(amount), concept };
      if (movement) await apiPatch(`/cash-movements/${movement.id}`, body);
      else await apiPost('/cash-movements', { ...body, siteId, shiftId: shiftId ? Number(shiftId) : undefined });
      onClose(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={movement ? 'Editar movimiento' : 'Registrar nuevo movimiento'}
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || !type || !(Number(amount) > 0) || (!movement && !shiftId)}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </>
      }
    >
      {!movement && !shift && isAdmin && (
        <label className="nx-form__field">
          <span>Caja (turno abierto)</span>
          <select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
            <option value="">{openShifts.length ? 'Seleccione' : 'No hay turnos abiertos'}</option>
            {openShifts.map((s) => <option key={s.id} value={s.id}>{s.zone.name} · {s.user.fullName}</option>)}
          </select>
        </label>
      )}
      <div className="nx-movtypes" role="radiogroup" aria-label="Tipo">
        {TYPES.filter((t) => isAdmin || !t.admin).map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={type === t.id}
            className={`nx-movtype nx-movtype--${t.id === 'BASE_IN' ? 'income' : t.id === 'BASE_OUT' ? 'expense' : t.tone}${type === t.id ? ' is-active' : ''}`}
            onClick={() => setType(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="nx-form__grid nx-form__grid--2">
        <label className="nx-form__field">
          <span>Valor</span>
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="nx-form__field">
          <span>Concepto (opcional)</span>
          <input value={concept} onChange={(e) => setConcept(e.target.value)} maxLength={200} />
        </label>
      </div>
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}
