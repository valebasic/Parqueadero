import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../context/SessionContext.jsx';
import { canAccess } from '../lib/roles.js';

// Sin sesión → login. Con sesión pero sin permiso para la ruta → aviso.
// Ojo: esto solo oculta pantallas; la autorización real la hace la API (Fase 3, 403).
export function RequireAuth({ children }) {
  const { session } = useSession();
  const location = useLocation();
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

export function RequireRole({ path, children }) {
  const { session } = useSession();
  if (!canAccess(session.user.role, path)) {
    return (
      <section className="nx-card nx-empty">
        <h2>Sin permiso</h2>
        <p>Su rol no tiene acceso a esta pantalla.</p>
      </section>
    );
  }
  return children;
}
