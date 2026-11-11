import { NavLink } from 'react-router-dom';
import Icon from './Icon.jsx';
import { menuForRole } from '../lib/roles.js';
import { useSession } from '../context/SessionContext.jsx';

// Menú lateral: solo muestra las opciones que el rol puede abrir.
export default function Sidebar({ open, onNavigate }) {
  const { session, logout } = useSession();
  const items = menuForRole(session.user.role);

  return (
    <aside className={`nx-sidebar${open ? ' is-open' : ''}`} aria-label="Menú principal">
      <div className="nx-sidebar__logo">
        Nexo<span>.app</span>
      </div>
      <nav className="nx-sidebar__nav">
        {items.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) => `nx-nav-link${isActive ? ' is-active' : ''}`}
            onClick={onNavigate}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <button type="button" className="nx-nav-link nx-nav-link--logout" onClick={logout}>
        <Icon name="logout" />
        <span>Salir</span>
      </button>
    </aside>
  );
}
