import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api.js';

// Sedes y zonas (solo AG). Por ahora es un listado de consulta; crear y editar llega más adelante.
export default function SitesPage() {
  const [state, setState] = useState({ status: 'loading', sites: [], error: '' });

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/sites', { signal: controller.signal })
      .then((sites) => setState({ status: 'ready', sites, error: '' }))
      .catch((err) => {
        if (err.name !== 'AbortError') setState({ status: 'error', sites: [], error: err.message });
      });
    return () => controller.abort();
  }, []);

  if (state.status === 'loading') {
    return <p className="nx-muted">Cargando sedes…</p>;
  }
  if (state.status === 'error') {
    return (
      <section className="nx-card nx-alert nx-alert--error" role="alert">
        <strong>No se pudieron cargar las sedes.</strong> {state.error}
      </section>
    );
  }
  if (state.sites.length === 0) {
    return (
      <section className="nx-card nx-empty">
        <h2>Sin sedes</h2>
        <p>Todavía no hay sedes registradas.</p>
      </section>
    );
  }

  return (
    <div className="nx-stack">
      {state.sites.map((site) => (
        <section key={site.id} className="nx-card">
          <header className="nx-card__header">
            <div>
              <h2 className="nx-card__title">{site.name}</h2>
              <p className="nx-muted nx-card__subtitle">
                {[site.address, site.city].filter(Boolean).join(' · ') || 'Sin dirección'}
              </p>
            </div>
            <span className={`nx-badge ${site.isActive ? 'nx-badge--ok' : 'nx-badge--off'}`}>
              {site.isActive ? 'Activa' : 'Inactiva'}
            </span>
          </header>

          <dl className="nx-facts">
            <div>
              <dt>Código</dt>
              <dd>{site.code}</dd>
            </div>
            <div>
              <dt>NIT</dt>
              <dd>{site.legalId || '—'}</dd>
            </div>
            <div>
              <dt>Teléfono</dt>
              <dd>{site.phone || '—'}</dd>
            </div>
            <div>
              <dt>Capacidad</dt>
              <dd>{site.capacity ?? '—'} cupos</dd>
            </div>
            <div>
              <dt>Prefijos de recibo</dt>
              <dd>
                {site.receiptPrefix} (entradas) · {site.monthlyReceiptPrefix} (mensualidades)
              </dd>
            </div>
          </dl>

          <h3 className="nx-section-title">Zonas ({site.zones.length})</h3>
          {site.zones.length === 0 ? (
            <p className="nx-muted">Esta sede no tiene zonas.</p>
          ) : (
            <div className="nx-table-wrap">
              <table className="nx-table">
                <thead>
                  <tr>
                    <th>Zona</th>
                    <th>Descripción</th>
                    <th className="nx-num">Capacidad</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {site.zones.map((zone) => (
                    <tr key={zone.id}>
                      <td>{zone.name}</td>
                      <td>{zone.description || '—'}</td>
                      <td className="nx-num">{zone.capacity ?? '—'}</td>
                      <td>
                        <span className={`nx-badge ${zone.isActive ? 'nx-badge--ok' : 'nx-badge--off'}`}>
                          {zone.isActive ? 'Activa' : 'Inactiva'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
