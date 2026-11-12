import { useEffect, useState } from 'react';
import { apiGet } from '../../lib/api.js';
import { localMap } from '../../lib/offline/engine.js';
import Modal from '../Modal.jsx';
import MapGrid, { MapLegend, MapViewport } from './MapGrid.jsx';

// Elegir el puesto de una entrada tocando el mapa (RF50). Solo se pueden tocar los puestos libres
// que sirven para el vehículo; la API vuelve a validar al registrar.
const ALLOWED = { CAR: ['CAR', 'REDUCED_MOBILITY'], MOTORCYCLE: ['MOTORCYCLE', 'MOTORCYCLE_BICYCLE'], BICYCLE: ['BICYCLE', 'MOTORCYCLE_BICYCLE'] };

export default function SpacePicker({ zoneId, vehicleType, plate, offline, snapshot, openEntries, suggestedId, onClose }) {
  const [map, setMap] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    if (offline) {
      setMap(localMap(snapshot, zoneId, openEntries));
      return;
    }
    apiGet(`/maps/zones/${zoneId}/live`).then(setMap).catch((e) => setError(e.message));
  }, [zoneId, offline, snapshot, openEntries]);

  // Reservados y "solo mensualidad" se ven, pero la API decide si son de esta placa
  const selectable = (el) => el.state === 'FREE' && (ALLOWED[vehicleType] ?? []).includes(el.spaceType);

  return (
    <Modal
      title={`Puesto para ${plate}`}
      wide
      onClose={() => onClose(null)}
      actions={<button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(null)}>Cancelar</button>}
    >
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
      {!map ? (
        <p className="nx-muted">Cargando mapa…</p>
      ) : !map.published ? (
        <p className="nx-muted">Esta zona no tiene mapa publicado.</p>
      ) : (
        <>
          <p className="nx-muted nx-small">Toque un puesto libre (verde). Los reservados o solo de mensualidad se validan al registrar.</p>
          <MapLegend counts={map.counts} />
          <MapViewport rows={map.rows} cols={map.cols} zoom={zoom} setZoom={setZoom}>
            <MapGrid
              layout={map}
              mode="select"
              zoom={zoom}
              selectedId={map.elements.find((e) => e.spaceId === suggestedId)?.id}
              isSelectable={selectable}
              onSelect={(el) => onClose({ id: el.spaceId, code: el.code, requiresKeys: Boolean(el.requiresKeys) })}
            />
          </MapViewport>
        </>
      )}
    </Modal>
  );
}
