import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import Topbar from '../components/Topbar.jsx';
import IdleGuard from '../components/IdleGuard.jsx';
import { LockScreen } from '../components/OfflineGuards.jsx';
import NexoIA from '../components/NexoIA.jsx';
import { useSession } from '../context/SessionContext.jsx';
import { MENU } from '../lib/roles.js';

const EXTRA_TITLES = { '/cuenta': 'Mi cuenta' };

// Estructura de todas las pantallas internas: menú lateral + barra superior + contenido.
// En pantallas angostas el menú se vuelve un panel deslizable.
export default function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { locked } = useSession();
  const { pathname } = useLocation();
  const title = MENU.find((m) => m.path === pathname)?.label || EXTRA_TITLES[pathname] || 'Nexo.app';

  return (
    <div className="nx-shell">
      <Sidebar open={menuOpen} onNavigate={() => setMenuOpen(false)} />
      {menuOpen && <div className="nx-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <div className="nx-main">
        <Topbar title={title} onToggleMenu={() => setMenuOpen((v) => !v)} />
        <main className="nx-content">
          {/* Bloqueada: no se muestra ningún dato detrás */}
          {locked ? null : <Outlet />}
        </main>
      </div>
      <IdleGuard />
      {/* Asistente NexoIA (no se muestra con la pantalla bloqueada) */}
      {!locked && <NexoIA />}
      {locked && <LockScreen />}
    </div>
  );
}
