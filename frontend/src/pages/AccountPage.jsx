import { useState } from 'react';
import { apiPut } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { ROLES } from '../lib/roles.js';
import { formatDateTime } from '../lib/format.js';

// Mi cuenta: datos del usuario y cambio de la contraseña propia (todos los roles).
export default function AccountPage() {
  const { user, session } = useSession();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [message, setMessage] = useState(null); // { type: 'ok' | 'error', text }
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) {
      setMessage({ type: 'error', text: 'La confirmación no coincide con la contraseña nueva.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await apiPut('/auth/password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      setMessage({ type: 'ok', text: 'Contraseña actualizada. Las demás sesiones abiertas se cerraron.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="nx-stack">
      <section className="nx-card">
        <header className="nx-card__header">
          <h2 className="nx-card__title">{user.fullName}</h2>
        </header>
        <dl className="nx-facts">
          <div>
            <dt>Usuario</dt>
            <dd>{user.username}</dd>
          </div>
          <div>
            <dt>Rol</dt>
            <dd>{ROLES[user.role]}</dd>
          </div>
          <div>
            <dt>Sedes</dt>
            <dd>{user.allSites ? 'Todas' : user.sites.map((s) => s.name).join(', ') || '—'}</dd>
          </div>
          <div>
            <dt>Cierre por inactividad</dt>
            <dd>{Math.round((session?.idleTimeoutSeconds ?? 0) / 60)} minutos</dd>
          </div>
          <div>
            <dt>Ingreso anterior</dt>
            <dd>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="nx-card">
        <header className="nx-card__header">
          <h2 className="nx-card__title">Cambiar contraseña</h2>
        </header>
        <form className="nx-form" onSubmit={handleSubmit} noValidate>
          <div className="nx-form__grid">
            <label className="nx-form__field">
              <span>Contraseña actual</span>
              <input type="password" value={form.currentPassword} onChange={set('currentPassword')} autoComplete="current-password" />
            </label>
            <label className="nx-form__field">
              <span>Contraseña nueva</span>
              <input
                type="password"
                value={form.newPassword}
                onChange={set('newPassword')}
                autoComplete="new-password"
                placeholder="Mínimo 8, con letras y números"
              />
            </label>
            <label className="nx-form__field">
              <span>Confirmar contraseña nueva</span>
              <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
            </label>
          </div>
          {message && (
            <p className={message.type === 'ok' ? 'nx-flash' : 'nx-form__alert'} role={message.type === 'ok' ? 'status' : 'alert'}>
              {message.text}
            </p>
          )}
          <div className="nx-form__actions">
            <button type="submit" className="nx-btn nx-btn--accent" disabled={saving}>
              {saving ? 'Guardando…' : 'Cambiar contraseña'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
