import { useEffect, useRef, useState } from 'react';

// Plano de una zona en SVG (RF47-RF49, RF52). Modos:
//   live    estado de cada puesto (verde libre, rojo ocupado, gris bloqueado)
//   select  igual que live, pero solo se pueden tocar los puestos que cumplen `isSelectable`
//   heat    mapa de calor de uso (escala azul secuencial)
//   editor  arrastrar, redimensionar y elegir elementos (lo controla MapEditorPage)
// Mensualidad (solo mensualidad o reservado): borde azul + calendario. Por hora: reloj.
// Íconos de moto, cicla y movilidad reducida. Techado: triángulo en la esquina.
export const CELL = 48;

const STATE_STYLE = {
  FREE: { fill: '#dcf5e5', stroke: '#1f8a4c', label: 'Libre' },
  OCCUPIED: { fill: '#fcd9d6', stroke: '#c62828', label: 'Ocupado' },
  BLOCKED: { fill: '#e3e5e8', stroke: '#8a9099', label: 'Bloqueado' },
  EDIT: { fill: '#ffffff', stroke: '#5f6670', label: '' },
};
const MONTHLY_BLUE = '#2f6fd6';
const TYPE_LABEL = { CAR: 'carro', MOTORCYCLE: 'moto', BICYCLE: 'cicla', MOTORCYCLE_BICYCLE: 'moto y cicla', REDUCED_MOBILITY: 'movilidad reducida' };
const FACING_LABEL = { N: 'arriba', S: 'abajo', E: 'la derecha', W: 'la izquierda' };
const USAGE_LABEL = { MONTHLY: 'solo mensualidad', HOURLY: 'por hora', MIXED: 'mixto' };

// Escala secuencial (azul claro → azul oscuro) para el mapa de calor
export function heatColor(pct) {
  const t = Math.max(0, Math.min(1, (pct ?? 0) / 100));
  const from = [234, 242, 253];
  const to = [16, 64, 140];
  const c = from.map((f, i) => Math.round(f + (to[i] - f) * t));
  return `rgb(${c.join(',')})`;
}

// --- Íconos (12 × 12 unidades) ---
export function ClockIcon({ x, y, s = 12, color = '#30343b' }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s / 12})`} aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="#fff" stroke={color} strokeWidth="1.3" />
      <path d="M6 3.2V6l2 1.4" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </g>
  );
}
export function CalendarIcon({ x, y, s = 12, color = MONTHLY_BLUE }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s / 12})`} aria-hidden="true">
      <rect x="1" y="2" width="10" height="9" rx="1.5" fill="#fff" stroke={color} strokeWidth="1.3" />
      <path d="M1 5h10M4 0.8v2.4M8 0.8v2.4" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </g>
  );
}
export function MotoIcon({ x, y, s = 12, color = '#30343b' }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s / 12})`} aria-hidden="true" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round">
      <circle cx="2.6" cy="8.6" r="2.1" />
      <circle cx="9.4" cy="8.6" r="2.1" />
      <path d="M2.6 8.6 5 5h3l1.4 3.6M6.5 5 7.4 3h1.8" />
    </g>
  );
}
export function BikeIcon({ x, y, s = 12, color = '#30343b' }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s / 12})`} aria-hidden="true" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round">
      <circle cx="2.6" cy="8.4" r="2.3" />
      <circle cx="9.4" cy="8.4" r="2.3" />
      <path d="M2.6 8.4 5 4.2h4l.4 4.2M5 4.2 6.4 8.4h3M4.4 2.8h1.6" />
    </g>
  );
}
export function KeyIcon({ x, y, s = 12, color = '#8a5a00' }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s / 12})`} aria-hidden="true" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round">
      <circle cx="3.6" cy="6" r="2.6" fill="#fff4d6" />
      <path d="M6.2 6h5M9.2 6v2.2M11 6v1.6" />
    </g>
  );
}
export function WheelchairIcon({ x, y, s = 12, color = '#1d4fa3' }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s / 12})`} aria-hidden="true" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round">
      <circle cx="5" cy="1.6" r="1.1" fill={color} stroke="none" />
      <path d="M5 3.2v3.6h3.2l1.4 2.8" />
      <path d="M3.4 5.2a3.2 3.2 0 1 0 4.4 4" />
    </g>
  );
}

function SpaceIcons({ el, x, y, w }) {
  const icons = [];
  const monthly = el.usage === 'MONTHLY' || el.reserved;
  if (monthly) icons.push(CalendarIcon);
  else icons.push(ClockIcon);
  if (el.usage === 'MIXED' && !el.reserved) icons.push(CalendarIcon);
  if (el.spaceType === 'MOTORCYCLE' || el.spaceType === 'MOTORCYCLE_BICYCLE') icons.push(MotoIcon);
  if (el.spaceType === 'BICYCLE' || el.spaceType === 'MOTORCYCLE_BICYCLE') icons.push(BikeIcon);
  if (el.requiresKeys) icons.push(KeyIcon);
  if (el.spaceType === 'REDUCED_MOBILITY') icons.push(WheelchairIcon);
  const size = 11;
  return icons.slice(0, Math.max(2, Math.floor((w - 6) / (size + 2)))).map((Icon, i) => <Icon key={i} x={x + 4 + i * (size + 2)} y={y + 4} s={size} />);
}

export function describeSpace(el) {
  const state = el.state ? STATE_STYLE[el.state].label.toLowerCase() : '';
  return [`Puesto ${el.code}`, state, TYPE_LABEL[el.spaceType], USAGE_LABEL[el.usage], el.reserved ? 'reservado' : '', el.covered ? 'techado' : '', el.requiresKeys ? 'pide llaves' : '', el.facing ? `frente hacia ${FACING_LABEL[el.facing]}` : '', el.entry ? `placa ${el.entry.plate}` : '']
    .filter(Boolean)
    .join(', ');
}

function FacingBar({ facing, x, y, w, h }) {
  const t = 4;
  const r = { N: [x + 10, y + 3, w - 20, t], S: [x + 10, y + h - 3 - t, w - 20, t], W: [x + 3, y + 10, t, h - 20], E: [x + w - 3 - t, y + 10, t, h - 20] }[facing];
  return <rect x={r[0]} y={r[1]} width={Math.max(2, r[2])} height={Math.max(2, r[3])} rx="2" fill="#4a5462" aria-hidden="true" />;
}

/**
 * @param {{ layout: {rows, cols, elements}, mode, zoom, selectedId, onSelect, isSelectable,
 *           onPlace, onUpdate, errorIds }} props
 */
export default function MapGrid({ layout, mode = 'live', zoom = 1, selectedId = null, onSelect, isSelectable, onPlace, onUpdate, errorIds }) {
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null); // { id, type: 'move'|'resize', dx, dy, row, col, width, height }
  const width = layout.cols * CELL;
  const height = layout.rows * CELL;
  const editor = mode === 'editor';

  function cellAt(event) {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { row: Math.floor(p.y / CELL), col: Math.floor(p.x / CELL) };
  }

  function onBackgroundDown(event) {
    if (!editor) return;
    const c = cellAt(event);
    if (c.row < 0 || c.col < 0 || c.row >= layout.rows || c.col >= layout.cols) return;
    onPlace?.(c.row, c.col);
  }

  function startDrag(event, el, type) {
    if (!editor) return;
    event.stopPropagation();
    onSelect?.(el.id);
    const c = cellAt(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ id: el.id, type, dx: c.col - el.col, dy: c.row - el.row, row: el.row, col: el.col, width: el.width, height: el.height });
  }

  function onMove(event) {
    if (!drag) return;
    const c = cellAt(event);
    if (drag.type === 'move') {
      setDrag((d) => ({ ...d, row: Math.max(0, Math.min(layout.rows - d.height, c.row - d.dy)), col: Math.max(0, Math.min(layout.cols - d.width, c.col - d.dx)) }));
    } else {
      setDrag((d) => ({ ...d, width: Math.max(1, Math.min(layout.cols - d.col, c.col - d.col + 1)), height: Math.max(1, Math.min(layout.rows - d.row, c.row - d.row + 1)) }));
    }
  }

  function endDrag() {
    if (!drag) return;
    const el = layout.elements.find((e) => e.id === drag.id);
    if (el) {
      const patch = drag.type === 'move' ? { row: drag.row, col: drag.col } : { width: drag.width, height: drag.height };
      if (Object.entries(patch).some(([k, v]) => el[k] !== v)) onUpdate?.(el.id, patch);
    }
    setDrag(null);
  }

  const geom = (el) => (drag && drag.id === el.id ? { ...el, row: drag.row, col: drag.col, width: drag.width, height: drag.height } : el);
  const order = { ROAD: 0, ENTRANCE: 1, EXIT: 1, BLOCKED: 2, SPACE: 3 };
  const elements = [...layout.elements].sort((a, b) => order[a.kind] - order[b.kind]);

  return (
    <svg
      ref={svgRef}
      className={`nx-map${editor ? ' nx-map--editor' : ''}`}
      width={width * zoom}
      height={height * zoom}
      viewBox={`0 0 ${width} ${height}`}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={() => setDrag(null)}
      role="img"
      aria-label={`Plano de ${layout.rows} filas por ${layout.cols} columnas`}
    >
      <defs>
        <pattern id="nx-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="#eceef1" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="#b3b8bf" strokeWidth="3" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="#f7f8fa" />
      {/* Cuadrícula */}
      <g className="nx-map__grid" aria-hidden="true">
        {Array.from({ length: layout.cols + 1 }, (_, i) => <line key={`c${i}`} x1={i * CELL} x2={i * CELL} y1={0} y2={height} />)}
        {Array.from({ length: layout.rows + 1 }, (_, i) => <line key={`r${i}`} y1={i * CELL} y2={i * CELL} x1={0} x2={width} />)}
      </g>
      {elements.map((raw) => {
        const el = geom(raw);
        const x = el.col * CELL;
        const y = el.row * CELL;
        const w = el.width * CELL;
        const h = el.height * CELL;
        const selected = selectedId === el.id;
        const invalid = errorIds?.has(el.id);
        const common = {
          key: el.id,
          className: `nx-map__el${selected ? ' is-selected' : ''}${invalid ? ' is-invalid' : ''}`,
          onPointerDown: editor ? (e) => startDrag(e, raw, 'move') : undefined,
        };
        if (el.kind !== 'SPACE') {
          const fill = { ROAD: '#d5d9df', ENTRANCE: '#c9f0d6', EXIT: '#fde2cc', BLOCKED: 'url(#nx-hatch)' }[el.kind];
          const text = { ROAD: '', ENTRANCE: el.label ?? 'Entrada', EXIT: el.label ?? 'Salida', BLOCKED: el.label }[el.kind];
          return (
            <g {...common} onClick={editor ? () => onSelect?.(el.id) : undefined}>
              <rect x={x + 1} y={y + 1} width={w - 2} height={h - 2} rx="4" fill={fill} stroke={el.kind === 'BLOCKED' ? '#8a9099' : 'none'} strokeDasharray={el.kind === 'BLOCKED' ? '4 3' : undefined} />
              {el.kind === 'ROAD' && w > CELL && <line x1={x + 8} x2={x + w - 8} y1={y + h / 2} y2={y + h / 2} stroke="#fff" strokeWidth="2" strokeDasharray="8 6" aria-hidden="true" />}
              {text && (
                <text x={x + w / 2} y={y + h / 2} className="nx-map__label" textAnchor="middle" dominantBaseline="middle" transform={h > w && w <= CELL ? `rotate(-90 ${x + w / 2} ${y + h / 2})` : undefined}>
                  {el.kind === 'ENTRANCE' ? '➜ ' : ''}{text}
                </text>
              )}
              {editor && selected && <rect className="nx-map__handle" x={x + w - 10} y={y + h - 10} width="10" height="10" onPointerDown={(e) => startDrag(e, raw, 'resize')} />}
            </g>
          );
        }
        // Puesto
        const st = mode === 'heat' ? null : STATE_STYLE[el.state ?? 'EDIT'];
        const monthly = el.usage === 'MONTHLY' || el.reserved;
        const selectable = mode === 'select' ? isSelectable?.(el) : mode === 'live' || mode === 'heat' || editor;
        const heatPct = mode === 'heat' ? el.heat?.utilization ?? 0 : null;
        const fill = mode === 'heat' ? heatColor(heatPct) : st.fill;
        const textColor = mode === 'heat' && heatPct > 55 ? '#fff' : '#1c2733';
        return (
          <g
            {...common}
            role={selectable ? 'button' : undefined}
            tabIndex={selectable && !editor ? 0 : undefined}
            aria-label={mode === 'heat' ? `Puesto ${el.code}, uso ${heatPct}%` : describeSpace(el)}
            aria-disabled={mode === 'select' && !selectable ? true : undefined}
            className={`${common.className} nx-map__space${mode === 'select' && !selectable ? ' is-disabled' : ''}`}
            onClick={!editor && selectable ? () => onSelect?.(el) : editor ? () => onSelect?.(el.id) : undefined}
            onKeyDown={!editor && selectable ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect?.(el)) : undefined}
          >
            <rect
              x={x + 3}
              y={y + 3}
              width={w - 6}
              height={h - 6}
              rx="6"
              fill={fill}
              stroke={monthly && mode !== 'heat' ? MONTHLY_BLUE : mode === 'heat' ? '#5f6670' : st.stroke}
              strokeWidth={monthly && mode !== 'heat' ? 3 : 1.5}
            />
            {el.state === 'BLOCKED' && mode !== 'heat' && <rect x={x + 3} y={y + 3} width={w - 6} height={h - 6} rx="6" fill="url(#nx-hatch)" opacity="0.7" aria-hidden="true" />}
            {el.covered && <path d={`M${x + w - 18} ${y + 3} h15 v15 z`} fill="#8a6d3b" opacity="0.8" aria-hidden="true" />}
            {/* Frente del carro (parqueo en reversa): barra gruesa en el lado que mira a la vía */}
            {el.facing && mode !== 'heat' && <FacingBar facing={el.facing} x={x} y={y} w={w} h={h} />}
            {mode !== 'heat' && <SpaceIcons el={el} x={x} y={y} w={w} />}
            <text x={x + w / 2} y={y + h / 2 + (el.entry ? -2 : 4)} className="nx-map__code" fill={textColor} textAnchor="middle" dominantBaseline="middle">
              {el.code}
            </text>
            {el.entry && mode !== 'heat' && (
              <text x={x + w / 2} y={y + h / 2 + 12} className="nx-map__plate" textAnchor="middle" dominantBaseline="middle">{el.entry.plate}</text>
            )}
            {mode === 'heat' && (
              <text x={x + w / 2} y={y + h / 2 + 14} className="nx-map__plate" fill={textColor} textAnchor="middle" dominantBaseline="middle">{heatPct}%</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// Leyenda (siempre visible en la vista en vivo)
export function MapLegend({ counts }) {
  const sw = (style, extra) => <svg width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="16" height="16" rx="4" fill={style.fill} stroke={style.stroke} strokeWidth="1.5" />{extra}</svg>;
  return (
    <ul className="nx-map-legend" aria-label="Convenciones del mapa">
      <li>{sw(STATE_STYLE.FREE)} Libre{counts ? ` (${counts.free})` : ''}</li>
      <li>{sw(STATE_STYLE.OCCUPIED)} Ocupado{counts ? ` (${counts.occupied})` : ''}</li>
      <li>{sw(STATE_STYLE.BLOCKED, <path d="M4 14 14 4M2 9l7-7M9 16l7-7" stroke="#9aa1a9" strokeWidth="1.5" />)} Bloqueado{counts ? ` (${counts.blocked})` : ''}</li>
      <li><svg width="18" height="18" aria-hidden="true"><rect x="1.5" y="1.5" width="15" height="15" rx="4" fill="#fff" stroke={MONTHLY_BLUE} strokeWidth="3" /></svg><svg width="14" height="14" aria-hidden="true"><CalendarIcon x={1} y={1} /></svg> Mensualidad</li>
      <li><svg width="14" height="14" aria-hidden="true"><ClockIcon x={1} y={1} /></svg> Por hora</li>
      <li><svg width="14" height="14" aria-hidden="true"><MotoIcon x={1} y={1} /></svg> Moto</li>
      <li><svg width="14" height="14" aria-hidden="true"><BikeIcon x={1} y={1} /></svg> Cicla</li>
      <li><svg width="14" height="14" aria-hidden="true"><WheelchairIcon x={1} y={1} /></svg> Movilidad reducida</li>
      <li><svg width="14" height="14" aria-hidden="true"><path d="M0 0h13v13z" fill="#8a6d3b" opacity="0.8" /></svg> Techado</li>
      <li><svg width="14" height="14" aria-hidden="true"><KeyIcon x={1} y={1} /></svg> Pide llaves</li>
      <li><svg width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="16" height="16" rx="4" fill="#fff" stroke="#8a9099" /><rect x="12" y="4" width="3" height="10" rx="1.5" fill="#4a5462" /></svg> Frente del carro (reversa)</li>
    </ul>
  );
}

// Contenedor con zoom (botones, Ctrl + rueda) y desplazamiento (táctil)
export function MapViewport({ rows, cols, zoom, setZoom, children, autoFit = true }) {
  const ref = useRef(null);
  function fit() {
    const w = ref.current?.clientWidth ?? 600;
    setZoom(Math.max(0.3, Math.min(2.5, (w - 8) / (cols * CELL))));
  }
  // Al abrir un plano más ancho que la pantalla, se ajusta solo (después se puede acercar)
  useEffect(() => {
    const w = ref.current?.clientWidth ?? 0;
    if (autoFit && w && cols * CELL > w) setZoom(Math.max(0.3, (w - 8) / (cols * CELL)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols]);
  return (
    <div className="nx-map-viewport">
      <div className="nx-map-zoom" role="group" aria-label="Zoom del mapa">
        <button type="button" onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.2).toFixed(2)))} aria-label="Alejar">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2)))} aria-label="Acercar">+</button>
        <button type="button" onClick={fit}>Ajustar</button>
      </div>
      <div
        ref={ref}
        className="nx-map-scroll"
        style={{ maxHeight: `${Math.max(240, Math.min(rows * CELL * zoom + 24, 1400))}px` }}
        onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          setZoom((z) => Math.max(0.3, Math.min(3, +(z - Math.sign(e.deltaY) * 0.1).toFixed(2))));
        }}
      >
        {children}
      </div>
    </div>
  );
}
