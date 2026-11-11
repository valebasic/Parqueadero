import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './layouts/AppLayout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import PlaceholderPage from './pages/PlaceholderPage.jsx';
import SitesPage from './pages/SitesPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import { RequireAuth, RequireRole } from './components/RequireAuth.jsx';
import { MENU } from './lib/roles.js';

// Fase en la que se construye cada pantalla (texto provisional)
const PHASE_BY_PATH = {
  '/': 'Fase 5',
  '/entradas': 'Fase 4',
  '/mensualidades': 'Fase 5',
  '/pendientes': 'Fase 4',
  '/caja': 'Fase 5',
  '/ventas': 'Fase 4',
  '/transacciones': 'Fase 5',
  '/reportes': 'Fase 5',
  '/reportes-mensualidades': 'Fase 5',
  '/configuracion': 'Fase 5',
};

// Pantallas ya construidas; el resto muestra el aviso provisional
const PAGE_BY_PATH = {
  '/usuarios': UsersPage,
  '/sedes': SitesPage,
};

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        {MENU.map((item) => {
          const Page = PAGE_BY_PATH[item.path];
          return (
            <Route
              key={item.path}
              path={item.path}
              element={
                <RequireRole path={item.path}>
                  {Page ? <Page /> : <PlaceholderPage title={item.label} phase={PHASE_BY_PATH[item.path]} />}
                </RequireRole>
              }
            />
          );
        })}
        {/* Disponible para todos los roles; se abre desde el usuario en la barra superior */}
        <Route path="/cuenta" element={<AccountPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
