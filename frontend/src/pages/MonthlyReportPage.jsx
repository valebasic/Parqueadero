import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../lib/api.js';
import { useWorkingSite } from '../context/ShiftContext.jsx';
import { useReceipt } from '../components/Receipt.jsx';
import Pager from '../components/Pager.jsx';
import { formatCOP, formatDate, formatDateTime, todayIso } from '../lib/format.js';

// Reporte de mensualidades: ingresos del período (recibos FM), historial de pagos y cartera.
const dateOnly = (s) => formatDate(`${s}T12:00:00`);
const monthStart = () => `${todayIso().slice(0, 8)}01`;

export default function MonthlyReportPage() {
  const { siteId, sites, setSiteId } = useWorkingSite();
  const { showReceipt } = useReceipt();
  const [f, setF] = useState({ from: monthStart(), to: todayIso(), method: '' });
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      setData(await apiGet(`/monthly/report?${new URLSearchParams({ siteId, ...f })}`));
      setPage(1);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId, f]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <div className="nx-stack">
      <section className="nx-card">
        <div className="nx-filters">
          {sites.length > 1 && (
            <label className="nx-form__field">
              <span>Sede</span>
              <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label className="nx-form__field"><span>Desde</span><input type="date" value={f.from} onChange={set('from')} /></label>
          <label className="nx-form__field"><span>Hasta</span><input type="date" value={f.to} onChange={set('to')} /></label>
          <label className="nx-form__field">
            <span>Forma de pago</span>
            <select value={f.method} onChange={set('method')}>
              <option value="">Todas</option>
              <option value="CASH">Efectivo</option>
              <option value="ELECTRONIC">Electrónico</option>
              <option value="MIXED">Efectivo + Electrónico</option>
            </select>
          </label>
          <div className="nx-filters__actions">
            <button type="button" className="nx-btn nx-btn--ghost" onClick={() => window.print()}>Imprimir</button>
          </div>
        </div>
      </section>
      {error && <div className="nx-banner nx-banner--error">{error}</div>}
      {data && (
        <>
          <section className="nx-card">
            <div className="nx-stats">
              <div className="nx-stat nx-stat--ok"><span>Ingresos del período</span><strong>{formatCOP(data.totals.amount)}</strong><small className="nx-muted">{data.totals.count} pagos</small></div>
              <div className="nx-stat"><span>Efectivo</span><strong>{formatCOP(data.totals.cash)}</strong></div>
              <div className="nx-stat nx-stat--info"><span>Electrónico</span><strong>{formatCOP(data.totals.electronic)}</strong></div>
              <div className="nx-stat nx-stat--danger"><span>Descuentos</span><strong>{formatCOP(data.totals.discounts)}</strong></div>
            </div>
            <h3 className="nx-section-title">Cartera hoy</h3>
            <div className="nx-stats nx-stats--compact">
              <div className="nx-stat nx-stat--ok"><span>Al día</span><strong>{data.portfolio.upToDate}</strong></div>
              <div className="nx-stat"><span>Por vencer (3 días)</span><strong>{data.portfolio.dueSoon}</strong></div>
              <div className="nx-stat"><span>Pendientes de pago</span><strong>{data.portfolio.pending}</strong></div>
              <div className="nx-stat nx-stat--danger"><span>En mora</span><strong>{data.portfolio.overdue}</strong></div>
              <div className="nx-stat nx-stat--accent"><span>Saldo por cobrar</span><strong>{formatCOP(data.portfolio.balance)}</strong></div>
            </div>
          </section>
          <section className="nx-card">
            <h2 className="nx-card__title nx-card__title--spaced">Historial de pagos</h2>
            <div className="nx-table-wrap">
              <table className="nx-table">
                <thead><tr><th>Recibo</th><th>Placa</th><th>Titular</th><th>Período</th><th className="nx-num">Valor</th><th>Forma</th><th>Fecha</th><th aria-label="Acciones" /></tr></thead>
                <tbody>
                  {data.payments.slice((page - 1) * 10, page * 10).map((p) => (
                    <tr key={p.id}>
                      <td>{p.receipt}{p.installmentNumber ? ` (abono ${p.installmentNumber})` : ''}{p.isAdvance ? ' · adelanto' : ''}</td>
                      <td><strong>{p.plate}</strong></td>
                      <td>{p.clientName}</td>
                      <td>{dateOnly(p.periodStart)} – {dateOnly(p.periodEnd)}</td>
                      <td className="nx-num">{formatCOP(p.amount)}</td>
                      <td>{p.paymentLabel}</td>
                      <td>{formatDateTime(p.paidAt)}</td>
                      <td><button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={async () => showReceipt(await apiGet(`/monthly/payments/${p.id}/receipt`))}>Recibo</button></td>
                    </tr>
                  ))}
                  {data.payments.length === 0 && <tr><td colSpan={8} className="nx-muted">No hay pagos en este período.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={10} count={data.payments.length} onChange={setPage} />
          </section>
        </>
      )}
    </div>
  );
}
