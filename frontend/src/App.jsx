import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './layouts/AppLayout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import PlaceholderPage from './pages/PlaceholderPage.jsx';
import SitesPage from './pages/SitesPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import EntriesPage from './pages/EntriesPage.jsx';
import CashPage from './pages/CashPage.jsx';
import SalesPage from './pages/SalesPage.jsx';
import PendingPage from './pages/PendingPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import MonthlyPage from './pages/MonthlyPage.jsx';
import MonthlyReportPage from './pages/MonthlyReportPage.jsx';
import TransactionsPage from './pages/TransactionsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import ConfigPage from './pages/ConfigPage.jsx';
import ConflictsPage from './pages/ConflictsPage.jsx';
import PanelPage from './pages/PanelPage.jsx';
import AccountingPage from './pages/AccountingPage.jsx';
import SchedulesPage from './pages/SchedulesPage.jsx';
import { RequireAuth, RequireRole } from './components/RequireAuth.jsx';
import { OnlineOnly } from './components/OfflineGuards.jsx';

// Sin conexión solo se opera en Entradas (RF60); el resto de pantallas necesita el servidor
const OFFLINE_OK = ['/entradas'];
import { MENU } from './lib/roles.js';

// Todas las pantallas del menú ya están construidas; el aviso provisional queda como respaldo
const PHASE_BY_PATH = {};

// Pantallas ya construidas; el resto muestra el aviso provisional
const PAGE_BY_PATH = {
  '/': DashboardPage,
  '/mensualidades': MonthlyPage,
  '/transacciones': TransactionsPage,
  '/reportes': ReportsPage,
  '/reportes-mensualidades': MonthlyReportPage,
  '/configuracion': ConfigPage,
  '/conflictos': ConflictsPage,
  '/entradas': EntriesPage,
  '/caja': CashPage,
  '/ventas': SalesPage,
  '/pendientes': PendingPage,
  '/usuarios': UsersPage,
  '/sedes': SitesPage,
  '/panel': PanelPage,
  '/contabilidad': AccountingPage,
  '/horarios': SchedulesPage,
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
                  {OFFLINE_OK.includes(item.path) ? (
                    <Page />
                  ) : (
                    <OnlineOnly what={item.label}>
                      {Page ? <Page /> : <PlaceholderPage title={item.label} phase={PHASE_BY_PATH[item.path]} />}
                    </OnlineOnly>
                  )}
                </RequireRole>
              }
            />
          );
        })}
        {/* Disponible para todos los roles; se abre desde el usuario en la barra superior */}
        <Route path="/cuenta" element={<OnlineOnly what="Mi cuenta"><AccountPage /></OnlineOnly>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
