// Actividad del usuario compartida entre pestañas (localStorage + evento `storage`).
// Así, si el operador trabaja en una pestaña, las otras no lo sacan por inactividad,
// y cerrar sesión en una pestaña la cierra en todas.

const ACTIVITY_KEY = 'nexo_last_activity';
const LOGOUT_KEY = 'nexo_logout';
const WRITE_THROTTLE_MS = 5000;

let lastLocalActivity = Date.now();
let lastWrite = 0;

function readShared() {
  try {
    return Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function markActivity() {
  const now = Date.now();
  lastLocalActivity = now;
  if (now - lastWrite < WRITE_THROTTLE_MS) return;
  lastWrite = now;
  try {
    localStorage.setItem(ACTIVITY_KEY, String(now));
  } catch {
    /* almacenamiento bloqueado: se usa solo la actividad de esta pestaña */
  }
}

// Última actividad en cualquier pestaña
export function lastActivity() {
  return Math.max(lastLocalActivity, readShared());
}

export function resetActivity() {
  lastLocalActivity = Date.now();
  lastWrite = 0;
  markActivity();
}

export function broadcastLogout(reason) {
  try {
    localStorage.setItem(LOGOUT_KEY, JSON.stringify({ reason, at: Date.now() }));
  } catch {
    /* sin efecto */
  }
}

export function subscribeToLogout(handler) {
  function onStorage(e) {
    if (e.key !== LOGOUT_KEY || !e.newValue) return;
    try {
      handler(JSON.parse(e.newValue).reason);
    } catch {
      handler('logout');
    }
  }
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
