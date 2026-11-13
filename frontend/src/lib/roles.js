// Roles de la v2.0:
//   AG = Administrador general (todas las sedes)
//   AS = Administrador de sede (solo sus sedes)
//   OP = Operador (opera una sede/zona en su turno)
export const ROLES = {
  AG: 'Administrador general',
  AS: 'Administrador de sede',
  OP: 'Operador',
};

const ALL = ['AG', 'AS', 'OP'];
const ADMINS = ['AG', 'AS'];

// Menú lateral. Mismo orden que la v1.0 (nav() en mvc/app-controller.js):
// el operador ve lo mismo que el "Empleado" de la v1.0; los administradores ven todo.
export const MENU = [
  { path: '/', label: 'Inicio', icon: 'dashboard', roles: ALL },
  { path: '/panel', label: 'Panel multisede', icon: 'building', roles: ADMINS },
  { path: '/entradas', label: 'Entradas', icon: 'marker', roles: ALL },
  // Mapa de espacios en vivo (RF48): todos los roles
  { path: '/mapa', label: 'Mapa', icon: 'map', roles: ALL },
  { path: '/mensualidades', label: 'Mensualidades', icon: 'calendar', roles: ADMINS },
  { path: '/pendientes', label: 'Pendientes', icon: 'clock', roles: ADMINS },
  { path: '/caja', label: 'Cierre de caja', icon: 'money', roles: ALL },
  { path: '/ventas', label: 'Ventas', icon: 'cart', roles: ALL },
  // El OP registra ingresos y egresos de su caja (con tope); el resto de reglas, en la API
  { path: '/transacciones', label: 'Transacciones', icon: 'exchange', roles: ALL },
  { path: '/reportes', label: 'Reportes', icon: 'chart', roles: ADMINS },
  { path: '/reportes-mensualidades', label: 'Rep. Mensualidades', icon: 'wallet', roles: ADMINS },
  { path: '/contabilidad', label: 'Contabilidad', icon: 'money', roles: ADMINS },
  { path: '/comparativo', label: 'Comparativo', icon: 'chart', roles: ADMINS },
  { path: '/ocupacion', label: 'Ocupación por puesto', icon: 'map', roles: ADMINS },
  { path: '/horarios', label: 'Horarios', icon: 'calendar', roles: ADMINS },
  { path: '/personal', label: 'Personal y turnos', icon: 'clock', roles: ADMINS },
  { path: '/conflictos', label: 'Conflictos', icon: 'alert', roles: ADMINS },
  { path: '/usuarios', label: 'Usuarios', icon: 'users', roles: ADMINS },
  { path: '/sedes', label: 'Sedes y zonas', icon: 'building', roles: ADMINS },
  { path: '/mapa-editor', label: 'Editor de mapas', icon: 'grid', roles: ADMINS },
  { path: '/configuracion', label: 'Configuración', icon: 'cog', roles: ADMINS },
];

export function menuForRole(role) {
  return MENU.filter((item) => item.roles.includes(role));
}

export function canAccess(role, path) {
  const item = MENU.find((m) => m.path === path);
  return Boolean(item && item.roles.includes(role));
}
