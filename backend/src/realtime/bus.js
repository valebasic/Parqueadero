// Bus de eventos en memoria entre los servicios y Socket.IO (evita dependencias circulares).
// Los servicios publican DESPUÉS de confirmar la transacción; realtime/index.js reenvía a las salas.
//
// Ojo: es por proceso. Con varias instancias de la API hay que usar el adaptador de Redis de
// Socket.IO para que un evento llegue a los clientes conectados a otra instancia.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

/**
 * Evento de una sede: llega a todos los usuarios con acceso a esa sede.
 * @param {number} siteId
 * @param {string} type  p. ej. 'entry:created'
 * @param {object} payload
 */
function publish(siteId, type, payload = {}) {
  if (!siteId) return;
  bus.emit('site-event', { siteId: Number(siteId), type, payload, at: new Date().toISOString() });
}

// Sesión revocada (logout, inactividad, contraseña): se desconectan sus sockets
function sessionEnded(sessionId, reason) {
  bus.emit('session-ended', { sessionId, reason });
}

// Todas las sesiones de un usuario revocadas (desactivado, contraseña restablecida)
function userSessionsEnded(userId, reason) {
  bus.emit('user-sessions-ended', { userId: Number(userId), reason });
}

module.exports = { bus, publish, sessionEnded, userSessionsEnded };
