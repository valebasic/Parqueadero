import { useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { useOffline } from '../context/OfflineContext.jsx';
import { resetActivity } from '../lib/activity.js';

// Pantalla de bloqueo local: navegador reabierto o inactividad sin conexión. La contraseña se
// verifica en el equipo contra el hash PBKDF2 guardado al iniciar sesión (no viaja a ningún lado).
export function LockScreen() {
  const { user, unlock, logout, offline } = useSession();
  const { pending } = useOffline();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const ok = await unlock(password).catch(() => false);
    setBusy(false);
    if (ok) {
      resetActivity();
      setPassword('');
    } else setError('Contraseña incorrecta.');
  }

  return (
    <div className="nx-modal-backdrop nx-lock" role="presentation">
      <form className="nx-modal" onSubmit={submit} aria-labelledby="lock-title">
        <h2 id="lock-title">Sesión bloqueada</h2>
        <p>
          {user.fullName}, escriba su contraseña para continuar
          {offline ? ' (sin conexión: se verifica en este equipo)' : ''}.
        </p>
        {pending > 0 && <p className="nx-banner nx-banner--warn">Hay {pending} operaciones guardadas por sincronizar.</p>}
        <label className="nx-form__field">
          <span>Contraseña</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
        </label>
        {error && <p className="nx-form__alert" role="alert">{error}</p>}
        <div className="nx-modal__actions">
          {!offline && (
            <button type="button" className="nx-btn nx-btn--ghost" onClick={() => logout('logout')}>
              Cerrar sesión
            </button>
          )}
          <button type="submit" className="nx-btn nx-btn--accent" disabled={!password || busy}>
            {busy ? 'Verificando…' : 'Desbloquear'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Envuelve las pantallas que necesitan el servidor: sin conexión muestran un aviso
export function OnlineOnly({ children, what = 'Esta pantalla' }) {
  const { online } = useOffline();
  if (online) return children;
  return (
    <section className="nx-card nx-empty" role="status">
      <h2>No disponible sin conexión</h2>
      <p>{what} necesita conexión con el servidor. Mientras tanto puede registrar entradas y salidas en Entradas.</p>
    </section>
  );
}
