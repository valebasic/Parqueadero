import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../context/SessionContext.jsx';
import { useOffline } from '../context/OfflineContext.jsx';

// Mensaje que se muestra al volver al login según por qué terminó la sesión anterior
const END_MESSAGES = {
  idle: 'Su sesión se cerró por inactividad. Ingrese de nuevo.',
  expired: 'Su sesión venció. Ingrese de nuevo.',
  revoked: 'Su sesión ya no es válida. Ingrese de nuevo.',
  inactive: 'Su usuario fue desactivado. Consulte con un administrador.',
};

export default function LoginPage() {
  const { status, login, endReason } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { online } = useOffline();

  if (status === 'authenticated') return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Escriba el usuario y la contraseña.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await login(username.trim(), password);
      navigate(location.state?.from?.pathname || '/', { replace: true });
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  const notice = !error && endReason ? END_MESSAGES[endReason] : null;

  return (
    <div className="nx-login">
      <section className="nx-login__card">
        <div className="nx-login__brand">
          Nexo<span>.app</span>
        </div>
        <div className="nx-login__rule" />
        <h1>Iniciar sesión</h1>
        <p className="nx-login__sub">Ingresa tus credenciales para continuar</p>

        {!online && (
          <div className="nx-login__msg is-error" role="alert">
            Sin conexión: no se puede iniciar una sesión nueva. Si tenía una sesión abierta en este equipo, recargue la
            página para continuar sin conexión.
          </div>
        )}
        <form onSubmit={handleSubmit} noValidate>
          <label className="nx-field">
            <span className="nx-sr-only">Usuario</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Usuario"
              autoComplete="username"
              autoFocus
              disabled={submitting}
            />
          </label>
          <label className="nx-field nx-field--password">
            <span className="nx-sr-only">Contraseña</span>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Contraseña"
              autoComplete="current-password"
              disabled={submitting}
            />
            <button
              type="button"
              className="nx-field__eye"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            >
              {showPassword ? 'Ocultar' : 'Ver'}
            </button>
          </label>

          {(error || notice) && (
            <div className={`nx-login__msg${error ? ' is-error' : ''}`} role="alert">
              {error || notice}
            </div>
          )}

          <button className="nx-btn nx-btn--accent nx-btn--block" type="submit" disabled={submitting || !online}>
            {submitting ? 'Ingresando…' : 'Iniciar sesión'}
          </button>
        </form>

        <p className="nx-login__helper">
          ¿Olvidó su contraseña? Un administrador puede restablecerla desde Usuarios.
        </p>
      </section>
    </div>
  );
}
