import { useCallback, useEffect, useState } from 'react';
import { apiDownload, apiGet } from '../lib/api.js';
import { formatCOP, formatDate, formatDateTime, todayIso } from '../lib/format.js';

// Contabilidad consolidada (RF29): estado de resultados por sede y consolidado, flujo de caja diario
// y diferencias de arqueo. Exportable a Excel. AG: todas las sedes; AS: las suyas.
function monthStart() {
  return `${todayIso().slice(0, 8)}01`;
}

export default function AccountingPage() {
  const [filters, setFilters] = useState({ from: monthStart(), to: todayIso(), siteId: 'all' });
  const [sites, setSites] = useState([]);
  const [data, setData] = useState(null);
  const [view, setView] = useState('all'); // 'all' = consolidado | id de sede (flujo y diferencias)
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet('/sites').then(setSites).catch(() => {});
  }, []);

  const qs = `from=${filters.from}&to=${filters.to}${filters.siteId !== 'all' ? `&siteId=${filters.siteId}` : ''}`;
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await apiGet(`/admin/accounting?${qs}`));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [qs]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const blocks = data ? [...data.sites.map((s) => ({ key: String(s.site.id), name: s.site.name, ...s })), { key: 'all', name: 'Consolidado', ...data.consolidated }] : [];
  const selected = blocks.find((b) => b.key === view) ?? blocks[blocks.length - 1];
  const categories = data ? Object.entries(data.categoryLabels) : [];

  return (
    <div className="nx-stack">
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
          <div className="nx-filters__actions">
            <button type="button" className="nx-btn nx-btn--ghost" onClick={() => apiDownload(`/admin/accounting/export?${qs}`, `contabilidad_${filters.from}_${filters.to}.xlsx`).catch((e) => setError(e.message))}>
              Exportar Excel
            </button>
          </div>
        </div>
      </section>

      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}
      {!data ? (
        <p className="nx-muted">{busy ? 'Cargando…' : ''}</p>
      ) : (
        <>
          <section className="nx-card">
            <h2 className="nx-card__title nx-card__title--spaced">Estado de resultados · {formatDate(data.range.from)} a {formatDate(data.range.to)}</h2>
            <div className="nx-table-wrap">
              <table className="nx-table nx-table--statement">
                <thead>
                  <tr>
                    <th>Concepto</th>
                    {blocks.map((b) => <th key={b.key} className="nx-num">{b.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <Row label="Parqueadero" blocks={blocks} get={(b) => b.statement.income.parking} />
                  <Row label="Mensualidades" blocks={blocks} get={(b) => b.statement.income.monthly} />
                  <Row label="Otros ingresos" blocks={blocks} get={(b) => b.statement.income.other} />
                  <Row label="Total ingresos" blocks={blocks} get={(b) => b.statement.income.total} strong />
                  {categories.map(([k, label]) => (
                    <Row key={k} label={`Egresos · ${label}`} blocks={blocks} get={(b) => -b.statement.expenses.byCategory[k]} hideZero />
                  ))}
                  <Row label="Total egresos" blocks={blocks} get={(b) => -b.statement.expenses.total} strong />
                  <Row label="Utilidad" blocks={blocks} get={(b) => b.statement.profit} strong tone />
                  <tr>
                    <td className="nx-muted">Margen</td>
                    {blocks.map((b) => <td key={b.key} className="nx-num nx-muted">{b.statement.margin != null ? `${b.statement.margin}%` : '—'}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="nx-muted nx-small">
              Parqueadero cuenta el día en que se cobró. Los movimientos de base (Base +/−, retiros) no son ingreso ni egreso.
            </p>
          </section>

          {blocks.length > 2 && (
            <section className="nx-card nx-card--tabs">
              <div className="nx-tabs" role="tablist">
                {blocks.map((b) => (
                  <button key={b.key} type="button" role="tab" aria-selected={selected.key === b.key} className={selected.key === b.key ? 'is-active' : ''} onClick={() => setView(b.key)}>
                    {b.name}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="nx-card">
            <h2 className="nx-card__title nx-card__title--spaced">Flujo de caja diario · {selected.name}</h2>
            <div className="nx-table-wrap">
              <table className="nx-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="nx-num">Parq. efectivo</th>
                    <th className="nx-num">Parq. electrónico</th>
                    <th className="nx-num">Mens. efectivo</th>
                    <th className="nx-num">Mens. electrónico</th>
                    <th className="nx-num">Otros ingresos</th>
                    <th className="nx-num">Egresos</th>
                    <th className="nx-num">Neto</th>
                    <th className="nx-num">Neto efectivo</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.cashFlow.filter((d) => d.income || d.expenses).map((d) => (
                    <tr key={d.date}>
                      <td>{formatDate(d.date)}</td>
                      <td className="nx-num">{formatCOP(d.parkingCash)}</td>
                      <td className="nx-num">{formatCOP(d.parkingElectronic)}</td>
                      <td className="nx-num">{formatCOP(d.monthlyCash)}</td>
                      <td className="nx-num">{formatCOP(d.monthlyElectronic)}</td>
                      <td className="nx-num">{formatCOP(d.otherIncome)}</td>
                      <td className="nx-num is-danger">{d.expenses ? `− ${formatCOP(d.expenses)}` : formatCOP(0)}</td>
                      <td className="nx-num"><strong>{formatCOP(d.net)}</strong></td>
                      <td className="nx-num">{formatCOP(d.cashNet)}</td>
                    </tr>
                  ))}
                  {!selected.cashFlow.some((d) => d.income || d.expenses) && (
                    <tr><td colSpan={9} className="nx-muted">Sin movimientos en el rango.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="nx-card">
            <h2 className="nx-card__title nx-card__title--spaced">Diferencias de arqueo · {selected.name}</h2>
            <div className="nx-stats">
              <div className="nx-stat nx-stat--danger"><span>Faltantes</span><strong>{formatCOP(selected.differences.totals.shortage)}</strong></div>
              <div className="nx-stat nx-stat--ok"><span>Sobrantes</span><strong>{formatCOP(selected.differences.totals.surplus)}</strong></div>
              <div className="nx-stat"><span>Cajas con diferencia</span><strong>{selected.differences.totals.count}</strong></div>
            </div>
            {selected.differences.items.length > 0 && (
              <div className="nx-table-wrap">
                <table className="nx-table">
                  <thead>
                    <tr>
                      <th>Cierre</th>
                      <th>Sede</th>
                      <th>Zona</th>
                      <th>Responsable</th>
                      <th className="nx-num">Esperado</th>
                      <th className="nx-num">Contado</th>
                      <th className="nx-num">Diferencia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.differences.items.map((d) => (
                      <tr key={d.cashRegisterId}>
                        <td>{formatDateTime(d.closedAt)}</td>
                        <td>{d.site.name}</td>
                        <td>{d.zone}</td>
                        <td>{d.user}</td>
                        <td className="nx-num">{formatCOP(d.expected)}</td>
                        <td className="nx-num">{formatCOP(d.counted)}</td>
                        <td className={`nx-num ${d.difference < 0 ? 'is-danger' : ''}`}><strong>{d.difference < 0 ? '− ' : '+ '}{formatCOP(Math.abs(d.difference))}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Row({ label, blocks, get, strong = false, tone = false, hideZero = false }) {
  if (hideZero && blocks.every((b) => !get(b))) return null;
  return (
    <tr className={strong ? 'nx-row--strong' : ''}>
      <td>{label}</td>
      {blocks.map((b) => {
        const v = get(b);
        return (
          <td key={b.key} className={`nx-num${tone && v < 0 ? ' is-danger' : ''}`}>
            {v < 0 ? `− ${formatCOP(-v)}` : formatCOP(v)}
          </td>
        );
      })}
    </tr>
  );
}
