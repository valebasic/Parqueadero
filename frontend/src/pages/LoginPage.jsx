import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../context/SessionContext.jsx';
import { ROLES } from '../lib/roles.js';

// Login (FASE 1: vacío, sin validar contra la API).
// El selector de rol solo aparece en desarrollo para revisar el menú de cada rol;
// en la Fase 3 el rol vendrá del token JWT y este selector desaparece.
export default function LoginPage() {
  const { session, login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState('OP');
  const [apiStatus, setApiStatus] = useState('checking');

  // Comprueba que el proxy de Vite llega al backend
  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => !cancelled && setApiStatus(data.ok ? 'up' : 'down'))
      .catch(() => !cancelled && setApiStatus('down'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (session) return <Navigate to="/" replace />;

  function handleSubmit(e) {
    e.preventDefault();
    login({ username: username.trim() || 'demo', role });
    navigate(location.state?.from?.pathname || '/', { replace: true });
  }

  return (
    <div className="nx-login">
      <section className="nx-login__card">
        <div className="nx-login__brand">
          Nexo<span>.app</span>
        </div>
        <div className="nx-login__rule" />
        <h1>Iniciar sesión</h1>
        <p className="nx-login__sub">Ingresa tus credenciales para continuar</p>

        <form onSubmit={handleSubmit} noValidate>
          <label className="nx-field">
            <span className="nx-sr-only">Usuario</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Usuario"
              autoComplete="username"
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

          {import.meta.env.DEV && (
            <label className="nx-dev-role">
              <span>Rol de prueba (solo desarrollo)</span>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {Object.entries(ROLES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {code} · {name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button className="nx-btn nx-btn--accent nx-btn--block" type="submit">
            Iniciar sesión
          </button>
        </form>

        <p className="nx-login__helper">
          Nexo.app · API{' '}
          <span className={`nx-dot nx-dot--${apiStatus}`} aria-hidden="true" />
          {apiStatus === 'up' ? 'conectada' : apiStatus === 'down' ? 'sin conexión' : 'verificando…'}
        </p>
      </section>
    </div>
  );
}
