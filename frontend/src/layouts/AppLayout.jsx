import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import Topbar from '../components/Topbar.jsx';
import { MENU } from '../lib/roles.js';

// Estructura de todas las pantallas internas: menú lateral + barra superior + contenido.
// En pantallas angostas el menú se vuelve un panel deslizable.
export default function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const title = MENU.find((m) => m.path === pathname)?.label || 'Nexo.app';

  return (
    <div className="nx-shell">
      <Sidebar open={menuOpen} onNavigate={() => setMenuOpen(false)} />
      {menuOpen && <div className="nx-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <div className="nx-main">
        <Topbar title={title} onToggleMenu={() => setMenuOpen((v) => !v)} />
        <main className="nx-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
