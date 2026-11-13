import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiDownload, apiGet } from '../lib/api.js';
import { useWorkingSite } from '../context/ShiftContext.jsx';
import LineChart from '../components/LineChart.jsx';
import Modal from '../components/Modal.jsx';
import Pager from '../components/Pager.jsx';
import { formatCOP, formatDate, formatDateTime, formatTime12h, PAYMENT_LABELS, todayIso } from '../lib/format.js';

// Reportes (RF20-RF22): KPIs, gráficas por hora/día/semana/mes según el rango, efectivo vs
// electrónico, cierres de caja con detalle, fidelidad de clientes y exportación a Excel y PDF.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function presetRange(key) {
  const t = new Date();
  const from = new Date(t);
  if (key === 'week') from.setDate(t.getDate() - ((t.getDay() + 6) % 7)); // desde el lunes
  if (key === 'month') from.setDate(1);
  if (key === 'year') from.setMonth(0, 1);
  if (key === 'all') return { from: '2020-01-01', to: iso(t) };
  return { from: iso(from), to: iso(t) };
}

const PRESETS = [
  ['today', 'Hoy'],
  ['week', 'Semana'],
  ['month', 'Mes'],
  ['year', 'Año'],
  ['all', 'Total'],
];

function bucketLabels(bucket, unit) {
  const d = new Date(bucket);
  const dm = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (unit === 'hour') {
    const end = new Date(d.getTime() + 59 * 60000);
    return { label: `${formatTime12h(d)} – ${formatTime12h(end)}`, short: formatTime12h(d).replace(':00', '') };
  }
  if (unit === 'week') return { label: `Semana del ${formatDate(d)}`, short: dm };
  if (unit === 'month') {
    const m = `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    return { label: m, short: m };
  }
  return { label: formatDate(d), short: dm };
}

const shortCOP = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace('.0', '')}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`);

export default function ReportsPage() {
  const { siteId, sites, setSiteId } = useWorkingSite();
  const [preset, setPreset] = useState('today');
  const [range, setRange] = useState(presetRange('today'));
  const [summary, setSummary] = useState(null);
  const [closures, setClosures] = useState([]);
  const [closurePage, setClosurePage] = useState(1);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState('');

  const load = useCallback(async () => {
    if (!siteId) return;
    const params = new URLSearchParams({ siteId, ...range });
    try {
      const [s, c] = await Promise.all([apiGet(`/reports/summary?${params}`), apiGet(`/reports/closures?${params}`)]);
      setSummary(s);
      setClosures(c);
      setClosurePage(1);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId, range]);

  useEffect(() => {
    load();
  }, [load]);

  const series = useMemo(
    () => (summary ? summary.series.map((s) => ({ ...s, ...bucketLabels(s.bucket, summary.granularity) })) : []),
    [summary],
  );

  async function exportAs(format) {
    setExporting(format);
    try {
      await apiDownload(`/reports/export?${new URLSearchParams({ format, siteId, ...range })}`, `reporte.${format}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting('');
    }
  }

  async function openClosure(id) {
    try {
      setDetail(await apiGet(`/reports/closures/${id}`));
    } catch (err) {
      setError(err.message);
    }
  }

  const k = summary?.kpis;
  const payTotal = k ? k.cash + k.electronic : 0;
  const unitWord = { hour: 'hora', day: 'día', week: 'semana', month: 'mes' }[summary?.granularity] ?? '';

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
          <div className="nx-form__field nx-filters__wide">
            <span>Período</span>
            <div className="nx-segmented" role="group" aria-label="Período">
              {PRESETS.map(([key, label]) => (
                <button key={key} type="button" className={preset === key ? 'is-active' : ''} onClick={() => { setPreset(key); setRange(presetRange(key)); }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="nx-form__field">
            <span>Desde</span>
            <input type="date" value={range.from} max={todayIso()} onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, from: e.target.value })); }} />
          </label>
          <label className="nx-form__field">
            <span>Hasta</span>
            <input type="date" value={range.to} onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, to: e.target.value })); }} />
          </label>
          <div className="nx-filters__actions">
            <button type="button" className="nx-btn nx-btn--ghost" onClick={() => exportAs('xlsx')} disabled={Boolean(exporting)}>
              {exporting === 'xlsx' ? 'Generando…' : 'Excel (.xlsx)'}
            </button>
            <button type="button" className="nx-btn nx-btn--ghost" onClick={() => exportAs('pdf')} disabled={Boolean(exporting)}>
              {exporting === 'pdf' ? 'Generando…' : 'PDF'}
            </button>
          </div>
        </div>
      </section>

      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}

      {k && (
        <>
          <section className="nx-card">
            <div className="nx-stats">
              <div className="nx-stat nx-stat--accent"><span>Vehículos</span><strong>{k.vehicles}</strong><small className="nx-muted">{k.exits} salidas</small></div>
              <div className="nx-stat nx-stat--ok"><span>Ingresos</span><strong>{formatCOP(k.income)}</strong><small className="nx-muted">Ventas {formatCOP(k.sales)} + manuales {formatCOP(k.incomes)}</small></div>
              <div className="nx-stat nx-stat--danger"><span>Egresos</span><strong>{formatCOP(k.expenses)}</strong></div>
              <div className="nx-stat"><span>Ganancia neta</span><strong>{formatCOP(k.net)}</strong></div>
              <div className="nx-stat"><span>Descuentos</span><strong>{formatCOP(k.discounts)}</strong></div>
              <div className="nx-stat"><span>Pendientes sin cobrar</span><strong>{formatCOP(k.pendingOpen)}</strong></div>
            </div>
            <h3 className="nx-section-title">Efectivo vs electrónico (ventas de parqueadero)</h3>
            <div className="nx-split" aria-label="Efectivo frente a electrónico">
              {payTotal > 0 ? (
                <>
                  <span className="nx-split__a" style={{ width: `${(k.cash / payTotal) * 100}%` }} />
                  <span className="nx-split__b" style={{ width: `${(k.electronic / payTotal) * 100}%` }} />
                </>
              ) : (
                <span className="nx-split__empty" />
              )}
            </div>
            <div className="nx-split__legend">
              <span><i className="nx-split__a" />Efectivo {formatCOP(k.cash)}{payTotal ? ` (${Math.round((k.cash / payTotal) * 100)} %)` : ''}</span>
              <span><i className="nx-split__b" />Electrónico {formatCOP(k.electronic)}{payTotal ? ` (${Math.round((k.electronic / payTotal) * 100)} %)` : ''}</span>
            </div>
          </section>

          <section className="nx-card">
            <LineChart
              title={`Ingresos y egresos por ${unitWord}`}
              data={series}
              series={[{ key: 'income', label: 'Ingresos' }, { key: 'expenses', label: 'Egresos' }]}
              format={formatCOP}
              axisFormat={shortCOP}
            />
          </section>
          <section className="nx-card">
            <LineChart
              title={`Entradas y salidas de vehículos por ${unitWord}`}
              data={series}
              series={[{ key: 'entries', label: 'Entradas' }, { key: 'exits', label: 'Salidas' }]}
              format={(v) => `${v}`}
            />
          </section>

          <section className="nx-card">
            <h2 className="nx-card__title nx-card__title--spaced">Cierres de caja</h2>
            {closures.length === 0 ? (
              <p className="nx-muted">No hay cierres en este período.</p>
            ) : (
              <>
                <div className="nx-table-wrap">
                  <table className="nx-table">
                    <thead>
                      <tr><th>Zona · operador</th><th>Cierre</th><th>Tipo</th><th className="nx-num">Ventas</th><th className="nx-num">Debía haber</th><th className="nx-num">Contado</th><th className="nx-num">Diferencia</th><th aria-label="Detalle" /></tr>
                    </thead>
                    <tbody>
                      {closures.slice((closurePage - 1) * 10, closurePage * 10).map((c) => (
                        <tr key={c.id}>
                          <td>{c.zone} · {c.user}</td>
                          <td>{formatDateTime(c.closedAt)}</td>
                          <td>{c.closeType === 'HANDOVER' ? 'Entrega' : 'Cierre'}</td>
                          <td className="nx-num">{formatCOP(c.totalSales)}</td>
                          <td className="nx-num">{formatCOP(c.expectedInDrawer)}</td>
                          <td className="nx-num">{formatCOP(c.counted)}</td>
                          <td className={`nx-num ${c.difference === 0 ? '' : 'is-danger'}`}>{formatCOP(c.difference)}</td>
                          <td><button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => openClosure(c.id)}>Ver</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={closurePage} pageSize={10} count={closures.length} onChange={setClosurePage} />
              </>
            )}
          </section>
        </>
      )}

      {siteId && <LoyaltySection siteId={siteId} />}
      {detail && <ClosureDetail detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ClosureDetail({ detail, onClose }) {
  const s = detail.summary ?? {};
  return (
    <Modal wide title={`Cierre de caja · ${detail.zone} · ${detail.user}`} onClose={onClose}
      actions={<button type="button" className="nx-btn nx-btn--ghost" onClick={onClose}>Cerrar</button>}>
      <p className="nx-muted">{formatDateTime(detail.openedAt)} a {formatDateTime(detail.closedAt)} · {detail.closeType === 'HANDOVER' ? 'Entrega de turno' : 'Cierre sin relevo'}</p>
      <div className="nx-stats nx-stats--compact">
        <div className="nx-stat nx-stat--base"><span>Base del día</span><strong>{formatCOP(s.baseFinal)}</strong></div>
        <div className="nx-stat"><span>Ventas</span><strong>{formatCOP(s.totalSales)}</strong></div>
        <div className="nx-stat nx-stat--info"><span>Electrónico</span><strong>{formatCOP(s.electronicSales)}</strong></div>
        <div className="nx-stat nx-stat--ok"><span>Efectivo esperado</span><strong>{formatCOP(s.expectedCash)}</strong></div>
        <div className="nx-stat"><span>Contado</span><strong>{formatCOP(s.countedTotal)}</strong></div>
      </div>
      <h3 className="nx-section-title">Movimientos</h3>
      <ul className="nx-plainlist">
        {detail.movements.length === 0 && <li className="nx-muted">Sin movimientos.</li>}
        {detail.movements.map((m, i) => (
          <li key={i}>{{ INCOME: 'Ingreso', EXPENSE: 'Egreso', BASE_IN: 'Base +', BASE_OUT: 'Base −' }[m.type]} · {formatCOP(m.amount)} · {m.withdrawal_to ? `retiro a ${m.withdrawal_to}` : m.concept || '—'}</li>
        ))}
      </ul>
      <h3 className="nx-section-title">Ventas ({detail.sales.length})</h3>
      <div className="nx-table-wrap">
        <table className="nx-table">
          <thead><tr><th>Recibo</th><th>Placa</th><th>Hora</th><th className="nx-num">Valor</th><th className="nx-num">Descuento</th><th>Pago</th></tr></thead>
          <tbody>
            {detail.sales.map((v) => (
              <tr key={v.receipt} className={v.discount_amount > 0 ? 'tone-discount' : v.payment_method === 'ELECTRONIC' ? 'tone-electronic' : 'tone-cash'}>
                <td>{v.receipt}</td><td>{v.plate}</td><td>{formatTime12h(v.paid_at)}</td>
                <td className="nx-num">{formatCOP(v.charged_amount)}</td>
                <td className="nx-num">{v.discount_amount ? `−${formatCOP(v.discount_amount)}` : '—'}</td>
                <td>{PAYMENT_LABELS[v.payment_method]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="nx-section-title">Arqueos</h3>
      <ul className="nx-plainlist">
        {detail.counts.map((c, i) => (
          <li key={i}>
            {{ OPENING: 'Apertura', HANDOVER: 'Entrega', CLOSING: 'Cierre' }[c.kind]} · {formatCOP(c.total)} contado por {c.counted_by}
            {c.received_by ? `, recibió ${c.received_by}` : ''}
            {c.difference != null ? ` · diferencia ${formatCOP(c.difference)}` : ''}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function LoyaltySection({ siteId }) {
  const [level, setLevel] = useState('');
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  useEffect(() => {
    apiGet(`/reports/loyalty?${new URLSearchParams({ siteId, level })}`).then((d) => { setData(d); setPage(1); }).catch(() => {});
  }, [siteId, level]);
  if (!data) return null;
  return (
    <section className="nx-card">
      <header className="nx-card__header">
        <div>
          <h2 className="nx-card__title">Fidelidad de clientes</h2>
          <p className="nx-muted nx-card__subtitle">Con todas las entradas de la sede. Puntaje: frecuencia 35 %, duración 25 %, regularidad 25 %, recencia 15 %.</p>
        </div>
        <label className="nx-form__field">
          <span>Ver</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">Todos (40 mejores)</option>
            <option value="loyal">Fiel</option>
            <option value="frequent">Frecuente</option>
            <option value="occasional">Ocasional</option>
            <option value="new">Nuevo</option>
          </select>
        </label>
      </header>
      <div className="nx-stats nx-stats--compact">
        <div className="nx-stat"><span>Clientes</span><strong>{data.totalClients}</strong></div>
        <div className="nx-stat"><span>Recurrentes</span><strong>{data.recurring}</strong></div>
        <div className="nx-stat"><span>Tasa de retorno</span><strong>{data.returnRate} %</strong></div>
        <div className="nx-stat"><span>Visitas por cliente</span><strong>{data.visitsPerClient}</strong></div>
        {data.levels.map((l) => <div key={l.key} className="nx-stat"><span>{l.label}</span><strong>{l.count}</strong></div>)}
      </div>
      <div className="nx-table-wrap">
        <table className="nx-table">
          <thead><tr><th>Placa</th><th>Nivel</th><th className="nx-num">Puntaje</th><th className="nx-num">Visitas</th><th className="nx-num">Total pagado</th><th className="nx-num">Estadía prom.</th><th className="nx-num">Días entre visitas</th><th>Última visita</th></tr></thead>
          <tbody>
            {data.clients.slice((page - 1) * 10, page * 10).map((c) => (
              <tr key={c.plate}>
                <td><strong>{c.plate}</strong>{c.hasMonthly && <span className="nx-tag">M</span>}</td>
                <td>{c.level.label}</td>
                <td className="nx-num">{c.score}</td>
                <td className="nx-num">{c.visits}</td>
                <td className="nx-num">{formatCOP(c.spent)}</td>
                <td className="nx-num">{c.avgHours == null ? '—' : `${c.avgHours} h`}</td>
                <td className="nx-num">{c.avgDaysBetween ?? '—'}</td>
                <td>{c.daysSinceLast === 0 ? 'hoy' : `hace ${c.daysSinceLast} días`}</td>
              </tr>
            ))}
            {data.clients.length === 0 && <tr><td colSpan={8} className="nx-muted">Sin clientes en este nivel.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={10} count={data.clients.length} onChange={setPage} />
    </section>
  );
}
