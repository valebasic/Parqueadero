import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import Modal from '../components/Modal.jsx';

// Sedes y zonas (RF26, RF27).
//   AG: crea y edita sedes (dirección, municipio, horario, capacidad por tipo, responsable), y las
//       activa o desactiva. AS: ve sus sedes y gestiona sus zonas. Nada se borra.
const TYPES = [
  ['CAR', 'Carros'],
  ['MOTORCYCLE', 'Motos'],
  ['BICYCLE', 'Ciclas'],
];
const TYPE_SHORT = { CAR: 'Carro', MOTORCYCLE: 'Moto', BICYCLE: 'Cicla' };

export default function SitesPage() {
  const { user } = useSession();
  const isAg = user.role === 'AG';
  const [sites, setSites] = useState(null);
  const [managers, setManagers] = useState([]);
  const [error, setError] = useState('');
  const [editingSite, setEditingSite] = useState(null); // 'new' | site
  const [editingZone, setEditingZone] = useState(null); // { site, zone | null }

  const load = useCallback(async () => {
    try {
      setSites(await apiGet(`/sites${isAg ? '?includeInactive=1' : ''}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [isAg]);

  useEffect(() => {
    load();
    if (isAg) apiGet('/users').then((list) => setManagers(list.filter((u) => u.role === 'AS' && u.isActive))).catch(() => {});
  }, [load, isAg]);

  async function toggleSite(site) {
    const verb = site.isActive ? 'Desactivar' : 'Activar';
    if (!window.confirm(`¿${verb} la sede ${site.name}?`)) return;
    try {
      await apiPatch(`/sites/${site.id}`, { isActive: !site.isActive });
      load();
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function toggleZone(site, zone) {
    try {
      await apiPatch(`/sites/${site.id}/zones/${zone.id}`, { isActive: !zone.isActive });
      load();
    } catch (err) {
      window.alert(err.message);
    }
  }

  if (error) return <div className="nx-banner nx-banner--error" role="alert">{error}</div>;
  if (!sites) return <p className="nx-muted">Cargando sedes…</p>;

  return (
    <div className="nx-stack">
      {isAg && (
        <section className="nx-card nx-card--tabs">
          <p className="nx-muted nx-small">Las sedes y zonas no se borran: se desactivan y conservan su historial.</p>
          <button type="button" className="nx-btn nx-btn--accent" onClick={() => setEditingSite('new')}>Nueva sede</button>
        </section>
      )}
      {sites.length === 0 && <section className="nx-card nx-empty"><h2>Sin sedes</h2></section>}
      {sites.map((site) => (
        <section key={site.id} className={`nx-card${site.isActive ? '' : ' nx-card--muted'}`}>
          <header className="nx-card__header">
            <div>
              <h2 className="nx-card__title">{site.name} <small className="nx-muted">· {site.code}</small></h2>
              <p className="nx-muted nx-card__subtitle">{[site.address, site.city].filter(Boolean).join(' · ') || 'Sin dirección'}</p>
            </div>
            <div className="nx-actions">
              <span className={`nx-badge ${site.isActive ? 'nx-badge--ok' : 'nx-badge--off'}`}>{site.isActive ? 'Activa' : 'Inactiva'}</span>
              {isAg && (
                <>
                  <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setEditingSite(site)}>Editar</button>
                  <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => toggleSite(site)}>{site.isActive ? 'Desactivar' : 'Activar'}</button>
                </>
              )}
            </div>
          </header>

          <dl className="nx-facts">
            <div><dt>Responsable</dt><dd>{site.manager?.fullName ?? '—'}</dd></div>
            <div><dt>NIT</dt><dd>{site.legalId || '—'}</dd></div>
            <div><dt>Teléfono</dt><dd>{site.phone || '—'}</dd></div>
            <div>
              <dt>Capacidad</dt>
              <dd>
                {site.capacity ?? '—'} cupos
                {site.capacityByType.CAR != null && (
                  <small className="nx-muted"> ({TYPES.map(([k]) => `${TYPE_SHORT[k]} ${site.capacityByType[k] ?? 0}`).join(' · ')})</small>
                )}
              </dd>
            </div>
            <div><dt>Horario</dt><dd className="nx-pre">{site.businessHours || '—'}</dd></div>
            <div><dt>Prefijos de recibo</dt><dd>{site.receiptPrefix} · {site.monthlyReceiptPrefix}</dd></div>
          </dl>

          <div className="nx-card__header">
            <h3 className="nx-section-title">Zonas ({site.zones.length})</h3>
            <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setEditingZone({ site, zone: null })}>Nueva zona</button>
          </div>
          <div className="nx-table-wrap">
            <table className="nx-table">
              <thead>
                <tr>
                  <th>Zona</th>
                  <th>Descripción</th>
                  <th>Admite</th>
                  <th className="nx-num">Capacidad</th>
                  <th>Estado</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {site.zones.map((zone) => (
                  <tr key={zone.id}>
                    <td>{zone.name}</td>
                    <td>{zone.description || '—'}</td>
                    <td>{zone.vehicleTypes.map((t) => TYPE_SHORT[t]).join(', ')}</td>
                    <td className="nx-num">{zone.capacity ?? '—'}</td>
                    <td><span className={`nx-badge ${zone.isActive ? 'nx-badge--ok' : 'nx-badge--off'}`}>{zone.isActive ? 'Activa' : 'Inactiva'}</span></td>
                    <td className="nx-actions">
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setEditingZone({ site, zone })}>Editar</button>
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => toggleZone(site, zone)}>{zone.isActive ? 'Desactivar' : 'Activar'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {editingSite && (
        <SiteForm
          site={editingSite === 'new' ? null : editingSite}
          sites={sites}
          managers={managers}
          onClose={(saved) => {
            setEditingSite(null);
            if (saved) load();
          }}
        />
      )}
      {editingZone && (
        <ZoneForm
          site={editingZone.site}
          zone={editingZone.zone}
          onClose={(saved) => {
            setEditingZone(null);
            if (saved) load();
          }}
        />
      )}
    </div>
  );
}

function useForm(initial) {
  const [form, setForm] = useState(initial);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return [form, setForm, set];
}

function SiteForm({ site, sites, managers, onClose }) {
  const creating = !site;
  const [form, , set] = useForm({
    code: site?.code ?? '',
    name: site?.name ?? '',
    legalId: site?.legalId ?? '',
    phone: site?.phone ?? '',
    address: site?.address ?? '',
    city: site?.city ?? '',
    businessHours: site?.businessHours ?? '',
    CAR: site?.capacityByType.CAR ?? '',
    MOTORCYCLE: site?.capacityByType.MOTORCYCLE ?? '',
    BICYCLE: site?.capacityByType.BICYCLE ?? '',
    managerUserId: site?.manager?.id ?? '',
    receiptPrefix: site?.receiptPrefix ?? 'FA',
    monthlyReceiptPrefix: site?.monthlyReceiptPrefix ?? 'FM',
    copyRatesFromSiteId: creating ? sites.find((s) => s.isActive)?.id ?? '' : '',
  });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const payload = {
      name: form.name,
      legalId: form.legalId,
      phone: form.phone,
      address: form.address,
      city: form.city,
      businessHours: form.businessHours,
      capacityByType: { CAR: num(form.CAR), MOTORCYCLE: num(form.MOTORCYCLE), BICYCLE: num(form.BICYCLE) },
      managerUserId: form.managerUserId ? Number(form.managerUserId) : null,
      receiptPrefix: form.receiptPrefix,
      monthlyReceiptPrefix: form.monthlyReceiptPrefix,
    };
    if (creating) {
      payload.code = form.code;
      if (form.copyRatesFromSiteId) payload.copyRatesFromSiteId = Number(form.copyRatesFromSiteId);
    }
    try {
      if (creating) await apiPost('/sites', payload);
      else await apiPatch(`/sites/${site.id}`, payload);
      onClose(true);
    } catch (err) {
      setErrors(err.details ?? {});
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const field = (key, label, props = {}) => (
    <label className="nx-form__field">
      <span>{label}</span>
      <input value={form[key]} onChange={set(key)} aria-invalid={Boolean(errors[key])} {...props} />
      {errors[key] && <small className="nx-form__error">{errors[key]}</small>}
    </label>
  );

  return (
    <Modal
      title={creating ? 'Nueva sede' : `Editar ${site.name}`}
      wide
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="submit" form="site-form" className="nx-btn nx-btn--accent" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
        </>
      }
    >
      <form id="site-form" className="nx-form" onSubmit={save} noValidate>
        <div className="nx-form__grid">
          {field('code', 'Código', { disabled: !creating, maxLength: 20, placeholder: 'NORTE' })}
          {field('name', 'Nombre', { maxLength: 120 })}
          {field('address', 'Dirección', { maxLength: 200 })}
          {field('city', 'Municipio', { maxLength: 80 })}
          {field('legalId', 'NIT', { maxLength: 40 })}
          {field('phone', 'Teléfono', { maxLength: 60 })}
          <label className="nx-form__field">
            <span>Responsable (administrador de sede)</span>
            <select value={form.managerUserId} onChange={set('managerUserId')}>
              <option value="">Sin responsable</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
            </select>
            {errors.managerUserId && <small className="nx-form__error">{errors.managerUserId}</small>}
          </label>
          {field('receiptPrefix', 'Prefijo recibos', { maxLength: 5 })}
          {field('monthlyReceiptPrefix', 'Prefijo mensualidades', { maxLength: 5 })}
        </div>
        <fieldset className="nx-form__fieldset">
          <legend>Capacidad por tipo de vehículo</legend>
          <div className="nx-form__grid nx-form__grid--dense">
            {TYPES.map(([k, label]) => (
              <label key={k} className="nx-form__field">
                <span>{label}</span>
                <input type="number" min="0" inputMode="numeric" value={form[k]} onChange={set(k)} aria-invalid={Boolean(errors[`capacityByType.${k}`])} />
                {errors[`capacityByType.${k}`] && <small className="nx-form__error">{errors[`capacityByType.${k}`]}</small>}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="nx-form__field">
          <span>Horario de atención</span>
          <textarea rows={3} value={form.businessHours} onChange={set('businessHours')} maxLength={500} />
        </label>
        {creating && (
          <label className="nx-form__field">
            <span>Copiar tarifas de</span>
            <select value={form.copyRatesFromSiteId} onChange={set('copyRatesFromSiteId')}>
              <option value="">No copiar (configurarlas después)</option>
              {sites.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        {error && <p className="nx-form__alert" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

function ZoneForm({ site, zone, onClose }) {
  const creating = !zone;
  const [form, setForm, set] = useForm({
    name: zone?.name ?? '',
    description: zone?.description ?? '',
    capacity: zone?.capacity ?? '',
    vehicleTypes: zone?.vehicleTypes ?? ['CAR', 'MOTORCYCLE', 'BICYCLE'],
  });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleType = (t) =>
    setForm((f) => ({ ...f, vehicleTypes: f.vehicleTypes.includes(t) ? f.vehicleTypes.filter((x) => x !== t) : [...f.vehicleTypes, t] }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload = {
      name: form.name,
      description: form.description,
      capacity: form.capacity === '' ? null : Number(form.capacity),
      vehicleTypes: form.vehicleTypes,
    };
    try {
      if (creating) await apiPost(`/sites/${site.id}/zones`, payload);
      else await apiPatch(`/sites/${site.id}/zones/${zone.id}`, payload);
      onClose(true);
    } catch (err) {
      setErrors(err.details ?? {});
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={creating ? `Nueva zona · ${site.name}` : `Editar zona ${zone.name}`}
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="submit" form="zone-form" className="nx-btn nx-btn--accent" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
        </>
      }
    >
      <form id="zone-form" className="nx-form" onSubmit={save} noValidate>
        <label className="nx-form__field">
          <span>Nombre</span>
          <input value={form.name} onChange={set('name')} maxLength={60} aria-invalid={Boolean(errors.name)} />
          {errors.name && <small className="nx-form__error">{errors.name}</small>}
        </label>
        <label className="nx-form__field">
          <span>Descripción</span>
          <input value={form.description} onChange={set('description')} maxLength={200} />
        </label>
        <label className="nx-form__field">
          <span>Capacidad (cupos)</span>
          <input type="number" min="0" value={form.capacity} onChange={set('capacity')} />
        </label>
        <fieldset className="nx-form__fieldset">
          <legend>Tipos de vehículo admitidos</legend>
          <div className="nx-checks">
            {TYPES.map(([k, label]) => (
              <label key={k} className="nx-check">
                <input type="checkbox" checked={form.vehicleTypes.includes(k)} onChange={() => toggleType(k)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {errors.vehicleTypes && <small className="nx-form__error">{errors.vehicleTypes}</small>}
        </fieldset>
        {error && <p className="nx-form__alert" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
