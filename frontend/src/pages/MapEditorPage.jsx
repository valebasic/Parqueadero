import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api.js';
import { useWorkingSite } from '../context/ShiftContext.jsx';
import { validateLayout } from '../lib/maplayout.js';
import { formatDateTime } from '../lib/format.js';
import Modal from '../components/Modal.jsx';
import MapGrid, { MapViewport } from '../components/map/MapGrid.jsx';

// Editor de mapas (RF47), AG y AS de la sede.
//   - Elegir una herramienta y tocar la cuadrícula para poner el elemento; arrastrar para moverlo;
//     el cuadrito de la esquina de una vía/entrada/salida/área la redimensiona.
//   - Teclado con un elemento seleccionado: flechas = mover, R = rotar, Supr = borrar, D = duplicar.
//   - Se valida en vivo (mismas reglas que el servidor): códigos únicos y sin superposición.
//   - Se guarda como borrador; publicar crea una versión nueva (la anterior queda archivada).
//   - Duplicar como plantilla: copia el plano de otra zona a esta como borrador.
const TOOLS = [
  { key: 'CAR', label: 'Puesto carro', kind: 'SPACE', spaceType: 'CAR' },
  { key: 'MOTORCYCLE', label: 'Puesto moto', kind: 'SPACE', spaceType: 'MOTORCYCLE' },
  { key: 'BICYCLE', label: 'Puesto cicla', kind: 'SPACE', spaceType: 'BICYCLE' },
  { key: 'MOTORCYCLE_BICYCLE', label: 'Puesto moto y cicla', kind: 'SPACE', spaceType: 'MOTORCYCLE_BICYCLE' },
  { key: 'REDUCED_MOBILITY', label: 'Movilidad reducida', kind: 'SPACE', spaceType: 'REDUCED_MOBILITY' },
  { key: 'ROAD', label: 'Vía', kind: 'ROAD' },
  { key: 'ENTRANCE', label: 'Entrada', kind: 'ENTRANCE' },
  { key: 'EXIT', label: 'Salida', kind: 'EXIT' },
  { key: 'BLOCKED', label: 'Área no disponible', kind: 'BLOCKED' },
];
const PREFIX = { CAR: 'A', MOTORCYCLE: 'M', BICYCLE: 'C', MOTORCYCLE_BICYCLE: 'M', REDUCED_MOBILITY: 'R' };
const EMPTY = { rows: 10, cols: 12, elements: [] };

let seq = 0;
const newId = () => `n${Date.now().toString(36)}${(seq += 1)}`;

function nextCode(elements, prefix) {
  const used = new Set(elements.filter((e) => e.kind === 'SPACE').map((e) => e.code));
  for (let i = 1; i < 1000; i += 1) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return `${prefix}${Date.now() % 1000}`;
}

function withSize(el) {
  if (el.kind !== 'SPACE' || el.size === 'custom') return el;
  const big = el.size === '1x2';
  return { ...el, width: big && el.orientation !== 'V' ? 2 : 1, height: big && el.orientation === 'V' ? 2 : 1 };
}

export default function MapEditorPage() {
  const { siteId, sites, setSiteId } = useWorkingSite();
  const [site, setSite] = useState(null);
  const [zoneId, setZoneId] = useState(null);
  const [info, setInfo] = useState(null); // { published, draft, versions }
  const [layout, setLayout] = useState(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    apiGet(`/sites/${siteId}`).then((s) => {
      setSite(s);
      setZoneId((z) => (s.zones.some((x) => x.id === z) ? z : s.zones.find((x) => x.isActive)?.id ?? null));
    });
  }, [siteId]);

  const loadZone = useCallback(async () => {
    if (!zoneId) return;
    const data = await apiGet(`/maps/zones/${zoneId}`);
    setInfo(data);
    const base = data.draft ?? data.published ?? EMPTY;
    setLayout({ rows: base.rows, cols: base.cols, elements: base.elements.map(withSize) });
    setDirty(false);
    setSelectedId(null);
  }, [zoneId]);

  useEffect(() => {
    loadZone().catch((e) => setMessage({ type: 'error', text: e.message }));
  }, [loadZone]);

  const validation = useMemo(() => validateLayout(layout), [layout]);
  // Elementos con problemas (para resaltarlos)
  const errorIds = useMemo(() => {
    const ids = new Set();
    for (const err of validation.errors) {
      for (const el of layout.elements) {
        if ((el.code && err.includes(`puesto ${el.code} `)) || (el.code && err.includes(`Puesto ${el.code}`)) || err.includes(`Elemento ${layout.elements.indexOf(el) + 1}:`)) ids.add(el.id);
      }
    }
    return ids;
  }, [validation, layout]);
  const selected = layout.elements.find((e) => e.id === selectedId) ?? null;

  const change = (fn) => {
    setLayout((l) => fn(l));
    setDirty(true);
  };
  const update = (id, patch) => change((l) => ({ ...l, elements: l.elements.map((e) => (e.id === id ? withSize({ ...e, ...patch }) : e)) }));
  const remove = (id) => {
    change((l) => ({ ...l, elements: l.elements.filter((e) => e.id !== id) }));
    setSelectedId(null);
  };

  function place(row, col) {
    // Tocar fuera de un elemento sin herramienta: deselecciona
    if (!tool) {
      setSelectedId(null);
      return;
    }
    const t = TOOLS.find((x) => x.key === tool);
    const el =
      t.kind === 'SPACE'
        ? withSize({ id: newId(), kind: 'SPACE', row, col, code: nextCode(layout.elements, PREFIX[t.spaceType]), spaceType: t.spaceType, usage: 'HOURLY', covered: false, requiresKeys: false, facing: null, size: '1x1', orientation: 'H' })
        : { id: newId(), kind: t.kind, row, col, width: 1, height: 1, ...(t.kind === 'BLOCKED' ? { label: 'No disponible' } : {}) };
    change((l) => ({ ...l, elements: [...l.elements, el] }));
    setSelectedId(el.id);
  }

  function duplicate(el) {
    const copy = { ...el, id: newId(), col: Math.min(layout.cols - el.width, el.col + el.width), ...(el.kind === 'SPACE' ? { code: nextCode(layout.elements, el.code.replace(/\d+$/, '') || 'P') } : {}) };
    change((l) => ({ ...l, elements: [...l.elements, copy] }));
    setSelectedId(copy.id);
  }

  function rotate(el) {
    if (el.kind === 'SPACE' && el.size !== 'custom') update(el.id, { orientation: el.orientation === 'V' ? 'H' : 'V' });
    else update(el.id, { width: el.height, height: el.width, ...(el.kind === 'SPACE' ? { orientation: el.orientation === 'V' ? 'H' : 'V' } : {}) });
  }

  // Atajos de teclado sobre el elemento seleccionado
  useEffect(() => {
    function onKey(e) {
      if (!selected || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[e.key]) {
        e.preventDefault();
        const [dr, dc] = moves[e.key];
        update(selected.id, { row: Math.max(0, selected.row + dr), col: Math.max(0, selected.col + dc) });
      } else if (e.key === 'Delete' || e.key === 'Backspace') remove(selected.id);
      else if (e.key.toLowerCase() === 'r') rotate(selected);
      else if (e.key.toLowerCase() === 'd') duplicate(selected);
      else if (e.key === 'Escape') setSelectedId(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function run(fn, ok) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ type: 'ok', text: ok });
    } catch (e) {
      setMessage({ type: 'error', text: e.message, list: e.details?.errors });
    } finally {
      setBusy(false);
    }
  }

  const saveDraft = () =>
    run(async () => {
      const data = await apiPut(`/maps/zones/${zoneId}/draft`, { rows: layout.rows, cols: layout.cols, elements: layout.elements });
      setInfo(data);
      setDirty(false);
    }, 'Borrador guardado. La operación sigue con el plano publicado hasta que publique.');

  const publish = () => {
    if (!window.confirm('¿Publicar este plano? Desde ese momento se usa para asignar puestos.')) return;
    run(async () => {
      if (dirty) await apiPut(`/maps/zones/${zoneId}/draft`, { rows: layout.rows, cols: layout.cols, elements: layout.elements });
      setInfo(await apiPost(`/maps/zones/${zoneId}/publish`));
      setDirty(false);
    }, 'Plano publicado.');
  };

  const discard = () => {
    if (!window.confirm('¿Descartar el borrador? Se vuelve al plano publicado.')) return;
    run(async () => {
      await apiDelete(`/maps/zones/${zoneId}/draft`);
      await loadZone();
    }, 'Borrador descartado.');
  };

  const zones = site?.zones.filter((z) => z.isActive) ?? [];

  return (
    <div className="nx-stack">
      <section className="nx-card nx-card--tabs">
        {sites.length > 1 && (
          <label className="nx-form__field nx-form__field--inline">
            <span>Sede</span>
            <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="nx-form__field nx-form__field--inline">
          <span>Zona</span>
          <select value={zoneId ?? ''} onChange={(e) => { if (!dirty || window.confirm('Hay cambios sin guardar. ¿Cambiar de zona?')) setZoneId(Number(e.target.value)); }}>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <div className="nx-map-status">
          {info?.published ? <span className="nx-badge nx-badge--ok">Publicada v{info.published.version}</span> : <span className="nx-badge nx-badge--off">Sin publicar</span>}
          {info?.draft && <span className="nx-badge nx-badge--warn">Borrador v{info.draft.version}</span>}
          {dirty && <span className="nx-badge nx-badge--info">Cambios sin guardar</span>}
        </div>
      </section>

      {message && (
        <div className={`nx-banner ${message.type === 'error' ? 'nx-banner--error' : 'nx-banner--ok'}`} role={message.type === 'error' ? 'alert' : 'status'}>
          {message.text}
          {message.list && <ul className="nx-plainlist">{message.list.map((x) => <li key={x}>{x}</li>)}</ul>}
        </div>
      )}

      {zoneId && (
        <div className="nx-editor">
          <section className="nx-card nx-editor__tools" aria-label="Herramientas">
            <h2 className="nx-card__title nx-card__title--spaced">Agregar</h2>
            <div className="nx-editor__palette" role="radiogroup" aria-label="Elemento a poner">
              {TOOLS.map((t) => (
                <button key={t.key} type="button" role="radio" aria-checked={tool === t.key} className={tool === t.key ? 'is-active' : ''} onClick={() => setTool(tool === t.key ? null : t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
            <p className="nx-muted nx-small">{tool ? 'Toque una celda vacía para ponerlo.' : 'Elija un elemento o toque uno del plano para editarlo.'}</p>
            <div className="nx-form__grid nx-form__grid--2">
              <label className="nx-form__field"><span>Filas</span><input type="number" min="1" max="80" value={layout.rows} onChange={(e) => change((l) => ({ ...l, rows: Number(e.target.value) || 1 }))} /></label>
              <label className="nx-form__field"><span>Columnas</span><input type="number" min="1" max="80" value={layout.cols} onChange={(e) => change((l) => ({ ...l, cols: Number(e.target.value) || 1 }))} /></label>
            </div>
            <div className="nx-stack nx-stack--tight">
              <button type="button" className="nx-btn nx-btn--ghost" onClick={saveDraft} disabled={busy || !dirty || validation.errors.length > 0}>Guardar borrador</button>
              <button type="button" className="nx-btn nx-btn--accent" onClick={publish} disabled={busy || validation.errors.length > 0 || (!dirty && !info?.draft)}>Publicar</button>
              {info?.draft && <button type="button" className="nx-btn nx-btn--ghost" onClick={discard} disabled={busy}>Descartar borrador</button>}
              <button type="button" className="nx-btn nx-btn--ghost" onClick={() => setCopying(true)} disabled={busy}>Usar plano de otra zona…</button>
            </div>
            {info?.versions?.length > 0 && (
              <details className="nx-editor__versions">
                <summary>Versiones ({info.versions.length})</summary>
                <ul className="nx-plainlist">
                  {info.versions.map((v) => (
                    <li key={v.version}>v{v.version} · {{ DRAFT: 'borrador', PUBLISHED: 'publicada', ARCHIVED: 'archivada' }[v.status]}{v.publishedAt ? ` · ${formatDateTime(v.publishedAt)}${v.publishedBy ? ` · ${v.publishedBy}` : ''}` : ''}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="nx-card nx-editor__canvas">
            <MapViewport rows={layout.rows} cols={layout.cols} zoom={zoom} setZoom={setZoom}>
              <MapGrid layout={layout} mode="editor" zoom={zoom} selectedId={selectedId} onSelect={setSelectedId} onPlace={place} onUpdate={update} errorIds={errorIds} />
            </MapViewport>
            {validation.errors.length > 0 ? (
              <div className="nx-banner nx-banner--error" role="alert">
                <strong>No se puede guardar todavía:</strong>
                <ul className="nx-plainlist">{validation.errors.slice(0, 8).map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            ) : (
              <p className="nx-muted nx-small">
                {layout.elements.filter((e) => e.kind === 'SPACE').length} puestos · plano válido. Atajos: flechas mueven, R rota, D duplica, Supr borra.
              </p>
            )}
          </section>

          <section className="nx-card nx-editor__props" aria-label="Propiedades">
            {!selected ? (
              <p className="nx-muted">Seleccione un elemento para editar sus propiedades.</p>
            ) : (
              <Properties el={selected} onChange={(patch) => update(selected.id, patch)} onRotate={() => rotate(selected)} onDuplicate={() => duplicate(selected)} onDelete={() => remove(selected.id)} />
            )}
          </section>
        </div>
      )}

      {copying && site && (
        <CopyDialog
          site={site}
          sites={sites}
          zoneId={zoneId}
          hasDraft={Boolean(info?.draft)}
          onClose={async (done) => {
            setCopying(false);
            if (done) {
              await loadZone();
              setMessage({ type: 'ok', text: 'Plano copiado como borrador. Revíselo y publíquelo.' });
            }
          }}
        />
      )}
    </div>
  );
}

function Properties({ el, onChange, onRotate, onDuplicate, onDelete }) {
  const title = { SPACE: `Puesto ${el.code}`, ROAD: 'Vía', ENTRANCE: 'Entrada', EXIT: 'Salida', BLOCKED: 'Área no disponible' }[el.kind];
  return (
    <div className="nx-stack nx-stack--tight">
      <h2 className="nx-card__title">{title}</h2>
      {el.kind === 'SPACE' ? (
        <>
          <label className="nx-form__field"><span>Código</span><input value={el.code} maxLength={10} onChange={(e) => onChange({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} /></label>
          <label className="nx-form__field">
            <span>Tipo</span>
            <select value={el.spaceType} onChange={(e) => onChange({ spaceType: e.target.value })}>
              <option value="CAR">Carro</option>
              <option value="MOTORCYCLE">Moto</option>
              <option value="BICYCLE">Cicla</option>
              <option value="MOTORCYCLE_BICYCLE">Moto y cicla</option>
              <option value="REDUCED_MOBILITY">Movilidad reducida</option>
            </select>
          </label>
          <label className="nx-form__field">
            <span>Uso</span>
            <select value={el.usage} onChange={(e) => onChange({ usage: e.target.value })}>
              <option value="HOURLY">Por hora</option>
              <option value="MONTHLY">Solo mensualidad</option>
              <option value="MIXED">Mixto</option>
            </select>
          </label>
          <label className="nx-form__field">
            <span>Tamaño</span>
            <select value={el.size} onChange={(e) => onChange(e.target.value === 'custom' ? { size: 'custom', width: el.width, height: el.height } : { size: e.target.value })}>
              <option value="1x1">1 × 1</option>
              <option value="1x2">1 × 2</option>
              <option value="custom">Libre (ancho × alto)</option>
            </select>
          </label>
          {el.size === 'custom' && (
            <div className="nx-form__grid nx-form__grid--2">
              <label className="nx-form__field"><span>Ancho</span><input type="number" min="1" max="20" value={el.width} onChange={(e) => onChange({ width: Math.max(1, Number(e.target.value) || 1) })} /></label>
              <label className="nx-form__field"><span>Alto</span><input type="number" min="1" max="20" value={el.height} onChange={(e) => onChange({ height: Math.max(1, Number(e.target.value) || 1) })} /></label>
            </div>
          )}
          <label className="nx-check"><input type="checkbox" checked={el.covered} onChange={(e) => onChange({ covered: e.target.checked })} /><span>Techado</span></label>
          <label className="nx-check">
            <input type="checkbox" checked={Boolean(el.requiresKeys)} onChange={(e) => onChange({ requiresKeys: e.target.checked })} />
            <span>Pide llaves (bloquea otros puestos)</span>
          </label>
          <label className="nx-form__field">
            <span>Frente del carro hacia (reversa)</span>
            <select value={el.facing ?? ''} onChange={(e) => onChange({ facing: e.target.value || null })}>
              <option value="">Sin indicar</option>
              <option value="N">Arriba</option>
              <option value="S">Abajo</option>
              <option value="E">Derecha</option>
              <option value="W">Izquierda</option>
            </select>
          </label>
        </>
      ) : (
        <>
          {['BLOCKED', 'ENTRANCE', 'EXIT'].includes(el.kind) && (
            <label className="nx-form__field">
              <span>Etiqueta</span>
              <input value={el.label ?? ''} maxLength={40} placeholder={{ ENTRANCE: 'Entrada', EXIT: 'Salida', BLOCKED: 'No disponible' }[el.kind]} onChange={(e) => onChange({ label: e.target.value })} />
            </label>
          )}
          <div className="nx-form__grid nx-form__grid--2">
            <label className="nx-form__field"><span>Ancho</span><input type="number" min="1" value={el.width} onChange={(e) => onChange({ width: Math.max(1, Number(e.target.value) || 1) })} /></label>
            <label className="nx-form__field"><span>Alto</span><input type="number" min="1" value={el.height} onChange={(e) => onChange({ height: Math.max(1, Number(e.target.value) || 1) })} /></label>
          </div>
        </>
      )}
      <div className="nx-form__grid nx-form__grid--2">
        <label className="nx-form__field"><span>Fila</span><input type="number" min="1" value={el.row + 1} onChange={(e) => onChange({ row: Math.max(0, (Number(e.target.value) || 1) - 1) })} /></label>
        <label className="nx-form__field"><span>Columna</span><input type="number" min="1" value={el.col + 1} onChange={(e) => onChange({ col: Math.max(0, (Number(e.target.value) || 1) - 1) })} /></label>
      </div>
      <div className="nx-form__actions nx-form__actions--start">
        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onRotate} disabled={el.kind === 'SPACE' && el.size === '1x1'}>Rotar</button>
        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onDuplicate}>Duplicar</button>
        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--danger-text" onClick={onDelete}>Eliminar</button>
      </div>
    </div>
  );
}

function CopyDialog({ site, sites, zoneId, hasDraft, onClose }) {
  const [sourceSite, setSourceSite] = useState(site.id);
  const [options, setOptions] = useState([]);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet(`/maps/sites/${sourceSite}`)
      .then((list) => setOptions(list.filter((z) => z.zoneId !== zoneId && (z.publishedVersion || z.hasDraft))))
      .catch((e) => setError(e.message));
  }, [sourceSite, zoneId]);

  async function save() {
    setSaving(true);
    try {
      await apiPost(`/maps/zones/${zoneId}/copy`, { sourceZoneId: Number(source), replace: true });
      onClose(true);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Usar el plano de otra zona"
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || !source}>Copiar como borrador</button>
        </>
      }
    >
      {hasDraft && <p className="nx-form__alert">El borrador actual de esta zona se reemplazará.</p>}
      {sites.length > 1 && (
        <label className="nx-form__field">
          <span>Sede</span>
          <select value={sourceSite} onChange={(e) => setSourceSite(Number(e.target.value))}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      <label className="nx-form__field">
        <span>Zona de origen</span>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">{options.length ? 'Seleccione' : 'No hay otras zonas con plano'}</option>
          {options.map((z) => <option key={z.zoneId} value={z.zoneId}>{z.name}{z.publishedVersion ? ` (v${z.publishedVersion})` : ' (borrador)'}</option>)}
        </select>
      </label>
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}
