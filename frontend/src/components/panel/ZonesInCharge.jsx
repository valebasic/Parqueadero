import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../lib/api.js';
import { formatCOP, formatDateTime, formatTime12h } from '../../lib/format.js';
import Modal from '../Modal.jsx';

// Quién está a cargo de cada zona ahora (RF31): responsable y desde qué hora, operaciones del turno,
// efectivo esperado, correcciones; quién debería estar según el horario y diferencias de los
// últimos 30 días (con el historial de turnos de la zona).
export default function ZonesInCharge({ refreshKey }) {
  const [zones, setZones] = useState(null);
  const [history, setHistory] = useState(null); // zona
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setZones(await apiGet('/admin/zones-status', { background: true }));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <section className="nx-card">
      <h2 className="nx-card__title nx-card__title--spaced">Zonas: quién está a cargo</h2>
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
      {!zones ? (
        <p className="nx-muted">Cargando…</p>
      ) : (
        <div className="nx-table-wrap">
          <table className="nx-table">
            <thead>
              <tr>
                <th>Sede · zona</th>
                <th>A cargo</th>
                <th className="nx-num">Entradas / salidas</th>
                <th className="nx-num">Ventas</th>
                <th className="nx-num">Efectivo esperado</th>
                <th className="nx-num">Correcciones</th>
                <th>Diferencias (30 días)</th>
                <th aria-label="Historial" />
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => (
                <tr key={z.zone.id}>
                  <td>
                    <strong>{z.zone.name}</strong>
                    <div className="nx-muted nx-small">{z.site?.name}</div>
                  </td>
                  <td>
                    {z.current ? (
                      <>
                        {z.current.user.fullName}
                        <div className="nx-muted nx-small">Desde {formatTime12h(z.current.since)}</div>
                      </>
                    ) : z.uncovered ? (
                      <span className="nx-badge nx-badge--danger nx-badge--wrap">
                        Sin turno · le toca a {z.scheduledNow.map((s) => s.user.fullName).join(', ')}
                      </span>
                    ) : (
                      <span className="nx-muted">Sin turno</span>
                    )}
                    {z.current && z.scheduledNow.length > 0 && !z.scheduledNow.some((s) => s.user.id === z.current.user.id) && (
                      <div className="nx-small is-danger">Programado: {z.scheduledNow.map((s) => s.user.fullName).join(', ')}</div>
                    )}
                  </td>
                  <td className="nx-num">{z.current ? `${z.current.operations.entries} / ${z.current.operations.exits}` : '—'}</td>
                  <td className="nx-num">{z.current ? <>{formatCOP(z.current.operations.salesTotal)}<div className="nx-muted nx-small">{z.current.operations.sales} ventas</div></> : '—'}</td>
                  <td className="nx-num">{z.current ? formatCOP(z.current.expectedInDrawer) : '—'}</td>
                  <td className="nx-num">
                    {z.current ? (
                      z.current.corrections.total ? (
                        <span className="nx-badge nx-badge--warn" title={`${z.current.corrections.paymentChanges} cambios de forma de pago · ${z.current.corrections.movementEdits} movimientos editados · ${z.current.corrections.movementDeletes} anulados`}>
                          {z.current.corrections.total}
                        </span>
                      ) : '0'
                    ) : '—'}
                  </td>
                  <td className="nx-small">
                    {z.history.withDifference
                      ? <>{z.history.withDifference} de {z.history.shifts} turnos · <span className="is-danger">−{formatCOP(z.history.shortage)}</span> · +{formatCOP(z.history.surplus)}</>
                      : <span className="nx-muted">{z.history.shifts ? `${z.history.shifts} turnos, sin diferencias` : 'Sin turnos'}</span>}
                  </td>
                  <td><button type="button" className="nx-linkbtn" onClick={() => setHistory(z.zone)}>Historial</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {history && <ZoneHistory zone={history} onClose={() => setHistory(null)} />}
    </section>
  );
}

function ZoneHistory({ zone, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet(`/admin/zones/${zone.id}/history?limit=30`).then(setData).catch((e) => setError(e.message));
  }, [zone.id]);
  return (
    <Modal title={`Historial · ${zone.name}`} wide onClose={onClose} actions={<button type="button" className="nx-btn nx-btn--ghost" onClick={onClose}>Cerrar</button>}>
      {error && <p className="nx-form__alert">{error}</p>}
      {!data ? (
        <p className="nx-muted">Cargando…</p>
      ) : data.items.length === 0 ? (
        <p className="nx-muted">La zona no tiene turnos cerrados.</p>
      ) : (
        <div className="nx-table-wrap">
          <table className="nx-table">
            <thead>
              <tr>
                <th>Responsable</th>
                <th>Turno</th>
                <th className="nx-num">Esperado</th>
                <th className="nx-num">Contado</th>
                <th className="nx-num">Diferencia</th>
                <th className="nx-num">Correcciones</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.shiftId}>
                  <td>{i.user}{i.adjustments > 0 && <div className="nx-small nx-muted">Ajustado ({i.adjustments})</div>}</td>
                  <td className="nx-small">{formatDateTime(i.workedStart)}<br />{formatDateTime(i.workedEnd)}</td>
                  <td className="nx-num">{formatCOP(i.expected)}</td>
                  <td className="nx-num">{formatCOP(i.counted)}</td>
                  <td className={`nx-num${i.difference < 0 ? ' is-danger' : ''}`}>{i.difference ? `${i.difference < 0 ? '−' : '+'} ${formatCOP(Math.abs(i.difference))}` : '—'}</td>
                  <td className="nx-num">{i.corrections || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
