import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../context/SessionContext.jsx';
import { canAccess } from '../lib/roles.js';

// Sin sesión → login. Con sesión pero sin permiso para la ruta → aviso.
// Esto solo ordena la interfaz: la autorización real la hace la API (401/403).
export function RequireAuth({ children }) {
  const { status } = useSession();
  const location = useLocation();
  if (status === 'loading') {
    return (
      <div className="nx-splash" role="status">
        Cargando…
      </div>
    );
  }
  if (status !== 'authenticated') return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

export function RequireRole({ path, children }) {
  const { user } = useSession();
  if (!canAccess(user.role, path)) {
    return (
      <section className="nx-card nx-empty">
        <h2>Sin permiso</h2>
        <p>Su rol no tiene acceso a esta pantalla.</p>
      </section>
    );
  }
  return children;
}
