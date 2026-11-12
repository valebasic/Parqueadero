import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { useShift, useWorkingSite } from '../context/ShiftContext.jsx';
import { useSiteEvents } from '../context/RealtimeContext.jsx';
import { useOffline } from '../context/OfflineContext.jsx';
import { loadSnapshot, localMap, localOpenEntries } from '../lib/offline/engine.js';
import { formatDuration, formatTime12h, formatDateTime } from '../lib/format.js';
import Modal from '../components/Modal.jsx';
import MapGrid, { MapLegend, MapViewport } from '../components/map/MapGrid.jsx';

// Mapa de espacios en vivo (RF48, RF49, RF51). Todos los roles.
//   Verde libre · rojo ocupado · gris bloqueado; mensualidad con borde azul y calendario; por hora con
//   reloj. Al tocar un puesto: placa, hora de entrada y tiempo transcurrido, y las acciones
//   (bloquear/liberar con motivo, mover el vehículo; reservar para una mensualidad: AS/AG).
//   Se actualiza con los eventos de tiempo real de la sede. Sin conexión usa la copia local.
const TYPE = { CAR: 'Carro', MOTORCYCLE: 'Moto', BICYCLE: 'Cicla', REDUCED_MOBILITY: 'Movilidad reducida' };
const USAGE = { MONTHLY: 'Solo mensualidad', HOURLY: 'Por hora', MIXED: 'Mixto (hora y mensualidad)' };
const STATE = { FREE: 'Libre', OCCUPIED: 'Ocupado', BLOCKED: 'Bloqueado' };

export default function MapPage() {
  const { user } = useSession();
  const { shift } = useShift();
  const { siteId, sites, setSiteId, lockedByShift } = useWorkingSite();
  const { online } = useOffline();
  const admin = user.role === 'AG' || user.role === 'AS';
  const [zones, setZones] = useState(null);
  const [zoneId, setZoneId] = useState(null);
  const [map, setMap] = useState(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState(null); // código del puesto
  const [moving, setMoving] = useState(null); // puesto de origen mientras se elige el destino
  const [dialog, setDialog] = useState(null); // { kind: 'block'|'unblock'|'move'|'reserve', space, target? }
  const [, setTick] = useState(0);

  // Zonas con plano publicado
  useEffect(() => {
    if (!siteId) return;
    if (!online) {
      loadSnapshot(siteId).then((snap) => {
        const list = (snap?.maps ?? []).map((m) => ({ zoneId: m.zone.id, name: m.zone.name, publishedVersion: m.version }));
        setZones(list);
        setZoneId((z) => z ?? (list.find((x) => x.zoneId === shift?.zone.id) ?? list[0])?.zoneId ?? null);
      });
      return;
    }
    apiGet(`/maps/sites/${siteId}`)
      .then((list) => {
        const withMap = list.filter((z) => z.publishedVersion);
        setZones(withMap);
        setZoneId((z) => (withMap.some((x) => x.zoneId === z) ? z : (withMap.find((x) => x.zoneId === shift?.zone.id) ?? withMap[0])?.zoneId ?? null));
      })
      .catch((e) => setError(e.message));
  }, [siteId, online, shift?.zone.id]);

  const load = useCallback(async () => {
    if (!zoneId) return;
    try {
      if (online) setMap(await apiGet(`/maps/zones/${zoneId}/live`, { background: true }));
      else {
        const snap = await loadSnapshot(siteId);
        setMap(localMap(snap, zoneId, await localOpenEntries(snap, user.id)));
      }
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [zoneId, online, siteId, user.id]);

  useEffect(() => {
    load();
  }, [load]);
  // Tiempo real: entradas, salidas, bloqueos, movimientos y publicación del plano
  useSiteEvents(siteId, null, () => load(), { debounceMs: 300 });
  // El tiempo transcurrido avanza solo
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const space = useMemo(() => map?.elements?.find((e) => e.kind === 'SPACE' && e.code === selected) ?? null, [map, selected]);

  function onSpace(el) {
    if (moving) {
      if (el.state === 'FREE' && el.code !== moving.code) setDialog({ kind: 'move', space: moving, target: el });
      return;
    }
    setSelected(el.code);
  }

  return (
    <div className="nx-stack">
      <section className="nx-card nx-card--tabs">
        {sites.length > 1 && !lockedByShift && (
          <label className="nx-form__field nx-form__field--inline">
            <span>Sede</span>
            <select value={siteId ?? ''} onChange={(e) => { setSiteId(Number(e.target.value)); setZoneId(null); setMap(null); }}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        {zones?.length > 0 && (
          <div className="nx-tabs" role="tablist" aria-label="Zonas">
            {zones.map((z) => (
              <button key={z.zoneId} type="button" role="tab" aria-selected={zoneId === z.zoneId} className={zoneId === z.zoneId ? 'is-active' : ''} onClick={() => { setZoneId(z.zoneId); setSelected(null); setMoving(null); }}>
                {z.name}
              </button>
            ))}
          </div>
        )}
        {!online && <span className="nx-badge nx-badge--warn">Sin conexión · copia local</span>}
      </section>

      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}
      {zones && zones.length === 0 && (
        <section className="nx-card nx-empty">
          <h2>Sin mapas publicados</h2>
          <p>{admin ? 'Diseñe y publique el plano de una zona en "Editor de mapas".' : 'Esta sede todavía no tiene mapa. Las entradas funcionan igual, sin puesto.'}</p>
        </section>
      )}

      {map?.published && (
        <div className="nx-map-layout">
          <section className="nx-card nx-map-card">
            <header className="nx-card__header">
              <h2 className="nx-card__title">{map.zone?.name}{map.version ? <small className="nx-muted"> · versión {map.version}</small> : null}</h2>
              <div className="nx-map-counts" aria-live="polite">
                <strong>{map.counts.free}</strong> libres · <strong>{map.counts.occupied}</strong> ocupados · {map.counts.blocked} bloqueados
                {map.counts.occupancy != null && <> · ocupación {map.counts.occupancy}%</>}
              </div>
            </header>
            <MapLegend counts={map.counts} />
            {moving && (
              <div className="nx-banner nx-banner--info" role="status">
                Toque un puesto libre para mover {moving.entry?.plate} desde {moving.code}.{' '}
                <button type="button" className="nx-linkbtn" onClick={() => setMoving(null)}>Cancelar</button>
              </div>
            )}
            <MapViewport rows={map.rows} cols={map.cols} zoom={zoom} setZoom={setZoom}>
              <MapGrid
                layout={map}
                mode={moving ? 'select' : 'live'}
                zoom={zoom}
                selectedId={space?.id}
                isSelectable={(el) => el.state === 'FREE' && el.code !== moving?.code}
                onSelect={onSpace}
              />
            </MapViewport>
          </section>

          <aside className={`nx-card nx-map-detail${space ? ' is-open' : ''}`} aria-live="polite">
            {!space ? (
              <p className="nx-muted">Toque un puesto para ver su detalle.</p>
            ) : (
              <SpaceDetail
                space={space}
                online={online}
                admin={admin}
                onClose={() => setSelected(null)}
                onBlock={() => setDialog({ kind: space.state === 'BLOCKED' ? 'unblock' : 'block', space })}
                onMove={() => { setMoving(space); setSelected(null); }}
                onReserve={() => setDialog({ kind: 'reserve', space })}
              />
            )}
          </aside>
        </div>
      )}

      {dialog && (
        <SpaceDialog
          {...dialog}
          siteId={siteId}
          onClose={(done) => {
            setDialog(null);
            if (dialog.kind === 'move') setMoving(null);
            if (done) load();
          }}
        />
      )}
    </div>
  );
}

function SpaceDetail({ space, online, admin, onClose, onBlock, onMove, onReserve }) {
  return (
    <div className="nx-stack nx-stack--tight">
      <header className="nx-card__header">
        <h2 className="nx-card__title">Puesto {space.code}</h2>
        <button type="button" className="nx-linkbtn" onClick={onClose} aria-label="Cerrar detalle">Cerrar</button>
      </header>
      <span className={`nx-badge ${space.state === 'FREE' ? 'nx-badge--ok' : space.state === 'OCCUPIED' ? 'nx-badge--danger' : 'nx-badge--off'}`}>{STATE[space.state]}</span>
      <dl className="nx-facts nx-facts--compact">
        <div><dt>Tipo</dt><dd>{TYPE[space.spaceType]}</dd></div>
        <div><dt>Uso</dt><dd>{USAGE[space.usage]}{space.reserved ? ' · reservado' : ''}</dd></div>
        <div><dt>Techado</dt><dd>{space.covered ? 'Sí' : 'No'}</dd></div>
        {space.entry && (
          <>
            <div><dt>Placa</dt><dd><strong>{space.entry.plate}</strong>{space.entry.offline ? ' (sin sincronizar)' : ''}</dd></div>
            <div><dt>Entrada</dt><dd>{formatTime12h(space.entry.entryAt)}<small className="nx-muted"> · {formatDateTime(space.entry.entryAt).split(' ')[0]}</small></dd></div>
            <div><dt>Tiempo</dt><dd>{formatDuration(Math.floor((Date.now() - new Date(space.entry.entryAt)) / 60000))}</dd></div>
            {space.entry.receipt && <div><dt>Recibo</dt><dd>{space.entry.receipt}</dd></div>}
          </>
        )}
        {space.state === 'BLOCKED' && space.blockedReason && <div><dt>Motivo</dt><dd>{space.blockedReason}</dd></div>}
      </dl>
      {online ? (
        <div className="nx-form__actions nx-form__actions--start">
          {space.state !== 'OCCUPIED' && (
            <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onBlock}>{space.state === 'BLOCKED' ? 'Liberar' : 'Bloquear'}</button>
          )}
          {space.state === 'OCCUPIED' && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onMove}>Mover vehículo</button>}
          {admin && space.usage !== 'HOURLY' && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onReserve}>{space.reserved ? 'Cambiar reserva' : 'Reservar'}</button>}
        </div>
      ) : (
        <p className="nx-muted nx-small">Sin conexión solo se consulta el mapa.</p>
      )}
    </div>
  );
}

function SpaceDialog({ kind, space, target, siteId, onClose }) {
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const [plans, setPlans] = useState([]);
  const [planId, setPlanId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const title = { block: `Bloquear ${space.code}`, unblock: `Liberar ${space.code}`, move: `Mover ${space.entry?.plate} de ${space.code} a ${target?.code}`, reserve: `Reservar ${space.code}` }[kind];

  useEffect(() => {
    if (kind !== 'reserve' || query.trim().length < 2) return undefined;
    const t = setTimeout(() => {
      apiGet(`/monthly?siteId=${siteId}&q=${encodeURIComponent(query.trim())}`).then((r) => setPlans(r.items)).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [kind, query, siteId]);

  async function save(remove = false) {
    setSaving(true);
    setError('');
    try {
      if (kind === 'block') await apiPost(`/spaces/${space.spaceId}/block`, { reason });
      else if (kind === 'unblock') await apiPost(`/spaces/${space.spaceId}/unblock`, { reason });
      else if (kind === 'move') await apiPost(`/spaces/move/${space.entry.id}`, { spaceId: target.spaceId, reason });
      else await apiPut(`/spaces/${space.spaceId}/reservation`, { monthlyPlanId: remove ? null : Number(planId) });
      onClose(true);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  const needsReason = kind !== 'reserve';
  return (
    <Modal
      title={title}
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          {kind === 'reserve' && space.reserved && (
            <button type="button" className="nx-btn nx-btn--ghost" onClick={() => save(true)} disabled={saving}>Quitar reserva</button>
          )}
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={() => save(false)} disabled={saving || (needsReason ? reason.trim().length < 3 : !planId)}>
            Confirmar
          </button>
        </>
      }
    >
      {needsReason ? (
        <label className="nx-form__field">
          <span>Motivo (queda en auditoría)</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
        </label>
      ) : (
        <>
          <p className="nx-muted nx-small">El puesto quedará reservado para el titular: nadie más lo podrá ocupar.</p>
          <label className="nx-form__field">
            <span>Buscar mensualidad (placa o nombre)</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          </label>
          <div className="nx-checks nx-checks--column" role="radiogroup" aria-label="Mensualidades">
            {plans.map((p) => (
              <label key={p.id} className="nx-check">
                <input type="radio" name="plan" checked={String(planId) === String(p.id)} onChange={() => setPlanId(p.id)} />
                <span><strong>{p.plate}</strong> · {p.clientName} · vence {p.endDate?.split('-').reverse().join('/')}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}
