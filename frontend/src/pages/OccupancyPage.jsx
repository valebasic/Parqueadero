import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../lib/api.js';
import { useWorkingSite } from '../context/ShiftContext.jsx';
import { useSiteEvents } from '../context/RealtimeContext.jsx';
import { todayIso } from '../lib/format.js';
import LineChart from '../components/LineChart.jsx';
import MapGrid, { MapViewport, heatColor } from '../components/map/MapGrid.jsx';

// Indicadores del mapa (RF52), AG y AS: ocupación por zona y tipo en tiempo real, histórico por
// hora y mapa de calor de uso de cada puesto.
const TYPE = { CAR: 'Carros', MOTORCYCLE: 'Motos', BICYCLE: 'Ciclas', REDUCED_MOBILITY: 'Movilidad reducida' };
const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'a. m.' : 'p. m.'}`;

export default function OccupancyPage() {
  const { siteId, sites, setSiteId } = useWorkingSite();
  const [zones, setZones] = useState(null);
  const [zoneId, setZoneId] = useState(null);
  const [range, setRange] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return { from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, to: todayIso() };
  });
  const [history, setHistory] = useState(null);
  const [heat, setHeat] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');

  const loadNow = useCallback(async () => {
    if (!siteId) return;
    try {
      const list = await apiGet(`/maps/indicators?siteId=${siteId}`, { background: true });
      setZones(list);
      setZoneId((z) => (list.some((x) => x.zoneId === z) ? z : list[0]?.zoneId ?? null));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [siteId]);

  useEffect(() => {
    loadNow();
  }, [loadNow]);
  useSiteEvents(siteId, null, () => loadNow(), { debounceMs: 500 });

  useEffect(() => {
    if (!zoneId) return;
    const qs = `from=${range.from}&to=${range.to}`;
    Promise.all([apiGet(`/maps/zones/${zoneId}/history?${qs}`), apiGet(`/maps/zones/${zoneId}/heatmap?${qs}`)])
      .then(([h, m]) => {
        setHistory(h);
        setHeat(m);
      })
      .catch((e) => setError(e.message));
  }, [zoneId, range]);

  const set = (k) => (e) => setRange((r) => ({ ...r, [k]: e.target.value }));

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
      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}
      {zones && zones.length === 0 && <section className="nx-card nx-empty"><h2>Sin mapas publicados</h2><p>Publique el plano de una zona para ver sus indicadores.</p></section>}

      {zones?.length > 0 && (
        <section className="nx-card">
          <h2 className="nx-card__title nx-card__title--spaced">Ocupación ahora</h2>
          <div className="nx-occ-zones">
            {zones.map((z) => (
              <button key={z.zoneId} type="button" className={`nx-occ-zone${zoneId === z.zoneId ? ' is-active' : ''}`} onClick={() => setZoneId(z.zoneId)} aria-pressed={zoneId === z.zoneId}>
                <span className="nx-occ-zone__head">
                  <strong>{z.zone}</strong>
                  <span>{z.occupancy == null ? '—' : `${z.occupancy}%`}</span>
                </span>
                <span className="nx-muted nx-small">{z.occupied} ocupados · {z.free} libres · {z.blocked} bloqueados{z.reserved ? ` · ${z.reserved} reservados` : ''}</span>
                {z.byType.map((t) => (
                  <span key={t.spaceType} className="nx-bars__row nx-bars__row--compact">
                    <span>{TYPE[t.spaceType]}</span>
                    <span className="nx-bars__track"><span className="nx-bars__fill" style={{ width: `${t.occupancy ?? 0}%`, display: 'block' }} /></span>
                    <span className="nx-bars__value">{t.occupied}/{t.total - t.blocked}</span>
                  </span>
                ))}
              </button>
            ))}
          </div>
        </section>
      )}

      {zoneId && (
        <section className="nx-card">
          <div className="nx-filters">
            <label className="nx-form__field"><span>Desde</span><input type="date" value={range.from} onChange={set('from')} /></label>
            <label className="nx-form__field"><span>Hasta</span><input type="date" value={range.to} onChange={set('to')} /></label>
          </div>
          {history && (
            <LineChart
              title={`Ocupación promedio por hora · ${history.zone.name}`}
              data={history.hours.map((h) => ({ label: hourLabel(h.hour), short: h.hour % 3 === 0 ? hourLabel(h.hour) : '', occupancy: h.occupancy ?? 0, avg: h.averageOccupied }))}
              series={[{ key: 'occupancy', label: 'Ocupación (%)' }]}
              format={(v) => `${v}%`}
              axisFormat={(v) => `${+v.toFixed(2)}%`}
            />
          )}
        </section>
      )}

      {heat?.elements && (
        <section className="nx-card">
          <header className="nx-card__header">
            <h2 className="nx-card__title">Mapa de calor · % del tiempo ocupado</h2>
            <div className="nx-heat-legend" aria-label="Escala del mapa de calor">
              <span>0%</span>
              <span className="nx-heat-legend__bar" style={{ background: `linear-gradient(to right, ${heatColor(0)}, ${heatColor(50)}, ${heatColor(100)})` }} />
              <span>100%</span>
            </div>
          </header>
          <MapViewport rows={heat.rows} cols={heat.cols} zoom={zoom} setZoom={setZoom}>
            <MapGrid layout={heat} mode="heat" zoom={zoom} />
          </MapViewport>
          <details>
            <summary className="nx-linkbtn">Ver tabla</summary>
            <div className="nx-table-wrap">
              <table className="nx-table">
                <thead><tr><th>Puesto</th><th className="nx-num">Uso</th><th className="nx-num">Entradas</th></tr></thead>
                <tbody>
                  {heat.elements.filter((e) => e.kind === 'SPACE').sort((a, b) => b.heat.utilization - a.heat.utilization).map((e) => (
                    <tr key={e.code}><td>{e.code}</td><td className="nx-num">{e.heat.utilization}%</td><td className="nx-num">{e.heat.entries}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </div>
  );
}
