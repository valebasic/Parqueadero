import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { ROLES } from '../lib/roles.js';
import { formatDateTime } from '../lib/format.js';

// Gestión de usuarios (AG y AS). Las reglas las aplica la API; aquí solo se evita ofrecer
// lo que el rol no puede hacer (p. ej. el AS solo crea operadores en sus sedes).
export default function UsersPage() {
  const { user: actor } = useSession();
  const [users, setUsers] = useState([]);
  const [sites, setSites] = useState([]);
  const [status, setStatus] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | usuario
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    try {
      const [usersData, sitesData] = await Promise.all([apiGet('/users'), apiGet('/sites')]);
      setUsers(usersData);
      setSites(sitesData.filter((s) => s.isActive));
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function handleSaved(saved, created) {
    setEditing(null);
    setFlash(created ? `Usuario ${saved.username} creado.` : `Cambios de ${saved.username} guardados.`);
    load();
  }

  if (status === 'loading') return <p className="nx-muted">Cargando usuarios…</p>;
  if (status === 'error') {
    return (
      <section className="nx-card nx-alert--error" role="alert">
        <strong>No se pudieron cargar los usuarios.</strong> {loadError}
      </section>
    );
  }

  return (
    <div className="nx-stack">
      <section className="nx-card">
        <header className="nx-card__header">
          <div>
            <h2 className="nx-card__title">Usuarios</h2>
            <p className="nx-muted nx-card__subtitle">
              {actor.role === 'AG'
                ? 'Administradores y operadores de todas las sedes.'
                : 'Operadores de sus sedes.'}
            </p>
          </div>
          <button type="button" className="nx-btn nx-btn--accent" onClick={() => { setFlash(''); setEditing('new'); }}>
            + Nuevo usuario
          </button>
        </header>

        {flash && (
          <p className="nx-flash" role="status">
            {flash}
          </p>
        )}

        {users.length === 0 ? (
          <p className="nx-muted">No hay usuarios para mostrar.</p>
        ) : (
          <div className="nx-table-wrap">
            <table className="nx-table">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Nombre</th>
                  <th>Rol</th>
                  <th>Sedes</th>
                  <th>Estado</th>
                  <th>Último ingreso</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.isActive ? '' : 'is-muted'}>
                    <td>
                      <strong>{u.username}</strong>
                      {u.id === actor.id && <span className="nx-muted"> (usted)</span>}
                    </td>
                    <td>{u.fullName}</td>
                    <td>{ROLES[u.role]}</td>
                    <td>{u.role === 'AG' ? 'Todas' : u.sites.map((s) => s.name).join(', ') || '—'}</td>
                    <td>
                      <UserStatus user={u} />
                    </td>
                    <td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Nunca'}</td>
                    <td className="nx-num">
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => { setFlash(''); setEditing(u); }}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <UserForm
          key={editing === 'new' ? 'new' : editing.id}
          actor={actor}
          sites={sites}
          user={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

function UserStatus({ user }) {
  if (!user.isActive) return <span className="nx-badge nx-badge--off">Inactivo</span>;
  if (user.isLocked) return <span className="nx-badge nx-badge--warn">Bloqueado</span>;
  return <span className="nx-badge nx-badge--ok">Activo</span>;
}

function UserForm({ actor, sites, user, onCancel, onSaved }) {
  const creating = !user;
  const isSelf = user?.id === actor.id;
  const actorIsAs = actor.role === 'AS';
  const visibleSiteIds = sites.map((s) => s.id);

  const [form, setForm] = useState(() => ({
    username: user?.username ?? '',
    fullName: user?.fullName ?? '',
    role: user?.role ?? 'OP',
    // El AS solo ve (y edita) las sedes que él administra
    siteIds: (user?.sites ?? []).map((s) => s.id).filter((id) => visibleSiteIds.includes(id)),
    password: '',
    isActive: user?.isActive ?? true,
  }));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: value }));
  };

  function toggleSite(id) {
    setForm((f) => ({
      ...f,
      siteIds: f.siteIds.includes(id) ? f.siteIds.filter((s) => s !== id) : [...f.siteIds, id],
    }));
  }

  function buildPayload() {
    const siteIds = form.role === 'AG' ? [] : [...form.siteIds].sort((a, b) => a - b);
    if (creating) {
      return {
        username: form.username.trim(),
        fullName: form.fullName,
        role: form.role,
        siteIds,
        password: form.password,
      };
    }
    const payload = {};
    if (form.fullName !== user.fullName) payload.fullName = form.fullName;
    if (form.role !== user.role) payload.role = form.role;
    const before = user.sites.map((s) => s.id).filter((id) => visibleSiteIds.includes(id)).sort((a, b) => a - b);
    if (form.role !== 'AG' && siteIds.join(',') !== before.join(',')) payload.siteIds = siteIds;
    if (form.role !== user.role && form.role !== 'AG') payload.siteIds = siteIds;
    if (form.isActive !== user.isActive) payload.isActive = form.isActive;
    if (form.password) payload.password = form.password;
    return payload;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const payload = buildPayload();
    if (!creating && Object.keys(payload).length === 0) {
      onCancel();
      return;
    }
    if (!creating && payload.isActive === false && !window.confirm(`¿Desactivar a ${user.username}? Se cerrarán sus sesiones.`)) {
      return;
    }
    setSaving(true);
    setErrors({});
    setFormError('');
    try {
      const saved = creating ? await apiPost('/users', payload) : await apiPatch(`/users/${user.id}`, payload);
      onSaved(saved, creating);
    } catch (err) {
      setErrors(err.details && typeof err.details === 'object' ? err.details : {});
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const roleOptions = actorIsAs ? ['OP'] : ['AG', 'AS', 'OP'];

  return (
    <section className="nx-card" aria-labelledby="user-form-title">
      <header className="nx-card__header">
        <h2 id="user-form-title" className="nx-card__title">
          {creating ? 'Nuevo usuario' : `Editar ${user.username}`}
        </h2>
      </header>

      <form className="nx-form" onSubmit={handleSubmit} noValidate>
        <div className="nx-form__grid">
          <label className="nx-form__field">
            <span>Usuario</span>
            <input
              value={form.username}
              onChange={set('username')}
              disabled={!creating}
              autoComplete="off"
              maxLength={40}
              aria-invalid={Boolean(errors.username)}
            />
            {errors.username && <small className="nx-form__error">{errors.username}</small>}
          </label>

          <label className="nx-form__field">
            <span>Nombre completo</span>
            <input value={form.fullName} onChange={set('fullName')} maxLength={80} aria-invalid={Boolean(errors.fullName)} />
            {errors.fullName && <small className="nx-form__error">{errors.fullName}</small>}
          </label>

          <label className="nx-form__field">
            <span>Rol</span>
            <select value={form.role} onChange={set('role')} disabled={isSelf || roleOptions.length === 1}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {ROLES[r]}
                </option>
              ))}
            </select>
            {isSelf && <small className="nx-muted">No puede cambiar su propio rol.</small>}
          </label>

          <label className="nx-form__field">
            <span>{creating ? 'Contraseña' : 'Nueva contraseña'}</span>
            <input
              type="password"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
              placeholder={creating ? 'Mínimo 8, con letras y números' : 'Dejar vacío para no cambiarla'}
              aria-invalid={Boolean(errors.password)}
            />
            {errors.password && <small className="nx-form__error">{errors.password}</small>}
          </label>
        </div>

        {form.role !== 'AG' ? (
          <fieldset className="nx-form__fieldset">
            <legend>Sedes</legend>
            <div className="nx-checks">
              {sites.map((s) => (
                <label key={s.id} className="nx-check">
                  <input type="checkbox" checked={form.siteIds.includes(s.id)} onChange={() => toggleSite(s.id)} />
                  <span>{s.name}</span>
                </label>
              ))}
            </div>
            {errors.siteIds && <small className="nx-form__error">{errors.siteIds}</small>}
          </fieldset>
        ) : (
          <p className="nx-muted">El administrador general tiene acceso a todas las sedes.</p>
        )}

        {!creating && (
          <label className="nx-check">
            <input type="checkbox" checked={form.isActive} onChange={set('isActive')} disabled={isSelf} />
            <span>Usuario activo{isSelf ? ' (no puede desactivarse a sí mismo)' : ''}</span>
          </label>
        )}

        {formError && (
          <p className="nx-form__alert" role="alert">
            {formError}
          </p>
        )}

        <div className="nx-form__actions">
          <button type="button" className="nx-btn nx-btn--ghost" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="nx-btn nx-btn--accent" disabled={saving}>
            {saving ? 'Guardando…' : creating ? 'Crear usuario' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </section>
  );
}
