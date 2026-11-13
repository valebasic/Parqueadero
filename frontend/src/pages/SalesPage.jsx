import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { useShift, useWorkingSite } from '../context/ShiftContext.jsx';
import { useReceipt } from '../components/Receipt.jsx';
import Modal from '../components/Modal.jsx';
import Pager from '../components/Pager.jsx';
import { formatCOP, formatDate, formatTime12h, PAYMENT_LABELS, todayIso } from '../lib/format.js';

// Ventas (RF19): salidas cobradas. Filtros por fecha, placa/recibo y forma de pago; reimpresión
// (queda en auditoría) y cambio de forma de pago con motivo obligatorio.
export default function SalesPage() {
  const { user } = useSession();
  const { shift } = useShift();
  const { siteId, sites, setSiteId, lockedByShift } = useWorkingSite();
  const { showReceipt } = useReceipt();
  const [filters, setFilters] = useState({ from: todayIso(), to: todayIso(), q: '', method: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    if (!siteId) return;
    const params = new URLSearchParams({ siteId, page, ...filters });
    try {
      setData(await apiGet(`/sales?${params}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId, page, filters]);

  useEffect(() => {
    const t = setTimeout(load, 200); // espera a que termine de escribir en el buscador
    return () => clearTimeout(t);
  }, [load]);

  const setFilter = (field) => (e) => {
    setPage(1);
    setFilters((f) => ({ ...f, [field]: e.target.value }));
  };

  async function reprint(sale) {
    try {
      showReceipt(await apiPost(`/sales/${sale.id}/reprint`));
    } catch (err) {
      setError(err.message);
    }
  }

  const isAdmin = user.role !== 'OP';
  const canEdit = (sale) => isAdmin || (sale.registerOpen && shift && sale.cashRegisterId === shift.cashRegisterId);

  return (
    <div className="nx-stack">
      <section className="nx-card">
        <div className="nx-filters">
          {!lockedByShift && sites.length > 1 && (
            <label className="nx-form__field">
              <span>Sede</span>
              <select value={siteId ?? ''} onChange={(e) => { setPage(1); setSiteId(Number(e.target.value)); }}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="nx-form__field">
            <span>Desde</span>
            <input type="date" value={filters.from} onChange={setFilter('from')} />
          </label>
          <label className="nx-form__field">
            <span>Hasta</span>
            <input type="date" value={filters.to} onChange={setFilter('to')} />
          </label>
          <label className="nx-form__field">
            <span>Buscar por placa o recibo</span>
            <input value={filters.q} onChange={setFilter('q')} placeholder="ABC123 o FA105" />
          </label>
          <label className="nx-form__field">
            <span>Forma de pago</span>
            <select value={filters.method} onChange={setFilter('method')}>
              <option value="">Todas</option>
              <option value="CASH">Efectivo</option>
              <option value="ELECTRONIC">Electrónico</option>
              <option value="MIXED">Efectivo + Electrónico</option>
            </select>
          </label>
        </div>
      </section>

      {error && (
        <div className="nx-banner nx-banner--error" role="alert">
          {error}
        </div>
      )}

      {data && (
        <section className="nx-card">
          <div className="nx-stats nx-stats--compact">
            <div className="nx-stat">
              <span>Ventas</span>
              <strong>{data.count}</strong>
            </div>
            <div className="nx-stat nx-stat--accent">
              <span>Total</span>
              <strong>{formatCOP(data.totals.charged)}</strong>
            </div>
            <div className="nx-stat nx-stat--ok">
              <span>Efectivo</span>
              <strong>{formatCOP(data.totals.cash)}</strong>
            </div>
            <div className="nx-stat nx-stat--info">
              <span>Electrónico</span>
              <strong>{formatCOP(data.totals.electronic)}</strong>
            </div>
            <div className="nx-stat nx-stat--danger">
              <span>Descuentos</span>
              <strong>{formatCOP(data.totals.discounts)}</strong>
            </div>
          </div>

          <div className="nx-table-wrap">
            <table className="nx-table">
              <thead>
                <tr>
                  <th>Recibo</th>
                  <th>Placa</th>
                  <th>Servicio</th>
                  <th>Entrada</th>
                  <th>Salida</th>
                  <th className="nx-num">Valor</th>
                  <th className="nx-num">Descuento</th>
                  <th>Forma de pago</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.id} className={rowTone(s)}>
                    <td>{s.receipt}</td>
                    <td>
                      <strong>{s.plate}</strong>
                    </td>
                    <td>{s.vehicleLabel}</td>
                    <td>
                      {formatDate(s.entryAt)} {formatTime12h(s.entryAt)}
                    </td>
                    <td>
                      {formatDate(s.exitAt)} {formatTime12h(s.exitAt)}
                    </td>
                    <td className="nx-num">{formatCOP(s.chargedAmount)}</td>
                    <td className="nx-num" title={s.discountReason || ''}>
                      {s.discountAmount > 0 ? `−${formatCOP(s.discountAmount)}` : '—'}
                    </td>
                    <td>{s.paymentLabel}</td>
                    <td className="nx-actions">
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => reprint(s)}>
                        Reimprimir
                      </button>
                      {canEdit(s) && (
                        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setEditing(s)}>
                          Cambiar pago
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={9} className="nx-muted">
                      No hay ventas con estos filtros.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} count={data.count} onChange={setPage} />
        </section>
      )}

      {editing && (
        <ChangePaymentModal
          sale={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// Colores suaves como en la v1.0: rojo = descuento (prioridad), azul = electrónico, verde = efectivo
function rowTone(s) {
  if (s.discountAmount > 0) return 'tone-discount';
  if (s.paymentMethod === 'ELECTRONIC') return 'tone-electronic';
  if (s.paymentMethod === 'CASH') return 'tone-cash';
  return 'tone-mixed';
}

function ChangePaymentModal({ sale, onCancel, onSaved }) {
  const [method, setMethod] = useState(sale.paymentMethod);
  const [cash, setCash] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError('');
    try {
      await apiPatch(`/sales/${sale.id}/payment`, {
        paymentMethod: method,
        cashAmount: method === 'MIXED' ? Number(cash) : undefined,
        reason,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Cambiar forma de pago · ${sale.receipt}`}
      onClose={onCancel}
      busy={saving}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || reason.trim().length < 3}>
            {saving ? 'Guardando…' : 'Guardar cambio'}
          </button>
        </>
      }
    >
      <p className="nx-muted">
        {sale.plate} · {formatCOP(sale.chargedAmount)} · hoy: {sale.paymentLabel}
      </p>
      <div className="nx-paymethods">
        {['CASH', 'ELECTRONIC', 'MIXED', 'PENDING'].map((m) => (
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
      {method === 'PENDING' && (
        <p className="nx-banner nx-banner--warn">La venta sale de Ventas y de la caja y queda en Pendientes hasta que se confirme el pago.</p>
      )}
      <label className="nx-form__field">
        <span>Motivo (obligatorio)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
      </label>
      {error && (
        <p className="nx-form__alert" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
