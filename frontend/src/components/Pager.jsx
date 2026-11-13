// Paginador único (como fpPager de la v1.0): Anterior · "Página X de Y · N registros" · Siguiente
export default function Pager({ page, pageSize, count, onChange }) {
  const pages = Math.max(1, Math.ceil(count / pageSize));
  if (count <= pageSize) return null;
  return (
    <nav className="nx-pager" aria-label="Paginación">
      <button type="button" className="nx-btn nx-btn--sm" onClick={() => onChange(page - 1)} disabled={page <= 1}>
        Anterior
      </button>
      <span>
        Página {page} de {pages} · {count} registros
      </span>
      <button type="button" className="nx-btn nx-btn--sm" onClick={() => onChange(page + 1)} disabled={page >= pages}>
        Siguiente
      </button>
    </nav>
  );
}
