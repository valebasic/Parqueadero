import { useEffect, useMemo, useRef, useState } from 'react';

// Gráfica de líneas en SVG, sin librerías.
//   - Un solo eje Y (nunca dos escalas); grilla tenue; líneas de 2 px.
//   - Leyenda siempre visible con 2 o más series; los colores siguen a la serie, no a su orden.
//   - Al pasar el mouse (o el dedo): línea guía vertical, puntos resaltados y tooltip con el valor exacto.
//   - "Ver tabla" muestra los mismos datos en una tabla (accesibilidad).
// Paleta categórica validada: serie 1 azul, serie 2 naranja.
export const SERIES_COLORS = ['#2a78d6', '#eb6834'];

function niceMax(max) {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

export default function LineChart({ title, data, series, format = (v) => String(v), axisFormat = format, height = 240 }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = { top: 12, right: 14, bottom: 30, left: 62 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const max = useMemo(() => niceMax(Math.max(0, ...data.flatMap((d) => series.map((s) => d[s.key] || 0)))), [data, series]);
  const n = data.length;
  const x = (i) => m.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v) => m.top + h - (v / max) * h;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const i = n <= 1 ? 0 : Math.round(((px - m.left) / w) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  const hovered = hover != null ? data[hover] : null;
  const tipLeft = hover != null ? Math.min(Math.max(x(hover) + 12, 0), width - 190) : 0;

  return (
    <figure className="nx-chart">
      <figcaption className="nx-chart__head">
        <strong>{title}</strong>
        {series.length > 1 && (
          <span className="nx-chart__legend">
            {series.map((s, i) => (
              <span key={s.key}>
                <i style={{ background: s.color ?? SERIES_COLORS[i] }} aria-hidden="true" />
                {s.label}
              </span>
            ))}
          </span>
        )}
        <button type="button" className="nx-linkbtn" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Ver gráfica' : 'Ver tabla'}
        </button>
      </figcaption>

      {showTable ? (
        <div className="nx-table-wrap nx-chart__table">
          <table className="nx-table">
            <thead>
              <tr>
                <th>Período</th>
                {series.map((s) => (
                  <th key={s.key} className="nx-num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  {series.map((s) => (
                    <td key={s.key} className="nx-num">
                      {format(d[s.key] || 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="nx-chart__plot" ref={wrapRef}>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={title}
            onMouseMove={onMove}
            onTouchStart={onMove}
            onTouchMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={m.left + w} y1={y(t)} y2={y(t)} className="nx-chart__grid" />
                <text x={m.left - 8} y={y(t)} className="nx-chart__axis" textAnchor="end" dominantBaseline="middle">
                  {axisFormat(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) =>
              i % labelEvery === 0 ? (
                <text key={d.label} x={x(i)} y={m.top + h + 18} className="nx-chart__axis" textAnchor="middle">
                  {d.short ?? d.label}
                </text>
              ) : null,
            )}
            {hover != null && <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + h} className="nx-chart__guide" />}
            {series.map((s, si) => (
              <polyline
                key={s.key}
                fill="none"
                stroke={s.color ?? SERIES_COLORS[si]}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={data.map((d, i) => `${x(i)},${y(d[s.key] || 0)}`).join(' ')}
              />
            ))}
            {hover != null &&
              series.map((s, si) => (
                <circle
                  key={s.key}
                  cx={x(hover)}
                  cy={y(hovered[s.key] || 0)}
                  r="4.5"
                  fill={s.color ?? SERIES_COLORS[si]}
                  stroke="#fff"
                  strokeWidth="2"
                />
              ))}
            {/* Área de captura más grande que las marcas */}
            <rect x={m.left} y={m.top} width={w} height={h} fill="transparent" />
          </svg>
          {hovered && (
            <div className="nx-chart__tip" style={{ left: tipLeft, top: 8 }} role="status">
              <strong>{hovered.label}</strong>
              {series.map((s, si) => (
                <span key={s.key}>
                  <i style={{ background: s.color ?? SERIES_COLORS[si] }} aria-hidden="true" />
                  {s.label}: <b>{format(hovered[s.key] || 0)}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
