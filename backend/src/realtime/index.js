// Tiempo real (RF28, RNF03) con Socket.IO sobre el mismo servidor HTTP.
//
//   - Autenticación con la misma sesión que la API: el cliente envía su JWT de acceso en
//     `auth.token`; se valida el token y la sesión en la base (no revocada, no vencida, sin exceder
//     la inactividad). Sin sesión → la conexión se rechaza (connect_error "AUTH_REQUIRED").
//   - Salas por sede ("site:<id>"): cada usuario entra solo a las de sus sedes (el AG, a todas).
//   - Si la sesión se revoca (logout, inactividad, usuario desactivado, contraseña), sus sockets se
//     desconectan de inmediato; además se revalida cada `REVALIDATE_MS` por si venció sola.
//   - Los sockets no cuentan como actividad: no mantienen viva una sesión inactiva.
//
// Eventos que recibe el cliente (siempre con { siteId, type, payload, at }):
//   entry:created · entry:exited · occupancy:changed · shift:opened · shift:closed · shift:handover
//   cash:movement · sales:changed · pending:changed · monthly:alerts
const { Server } = require('socket.io');
const env = require('../config/env');
const { query } = require('../db/pool');
const { verifyAccessToken } = require('../services/token.service');
const { resolveSession } = require('../services/auth.service');
const { bus, publish } = require('./bus');

const REVALIDATE_MS = Number.parseInt(process.env.REALTIME_REVALIDATE_MS, 10) || 60000;
const ALERTS_EVERY_MS = 30 * 60 * 1000;

let io = null;

const siteRoom = (siteId) => `site:${siteId}`;

async function siteIdsFor(user) {
  if (user.role !== 'AG') return user.siteIds;
  const { rows } = await query('SELECT id FROM sites WHERE is_active');
  return rows.map((r) => r.id);
}

// Middleware de conexión: rechaza sin sesión válida
async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(Object.assign(new Error('AUTH_REQUIRED'), { data: { code: 'AUTH_REQUIRED' } }));
    let claims;
    try {
      claims = verifyAccessToken(token);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
      return next(Object.assign(new Error(code), { data: { code } }));
    }
    const user = await resolveSession(claims, null, { countsAsActivity: false });
    socket.data.user = user;
    socket.data.claims = claims;
    return next();
  } catch (err) {
    const code = err.code || 'AUTH_REQUIRED';
    return next(Object.assign(new Error(code), { data: { code } }));
  }
}

function endSocket(socket, reason) {
  socket.emit('session:ended', { reason });
  socket.disconnect(true);
}

async function revalidateAll() {
  if (!io) return;
  for (const socket of await io.fetchSockets()) {
    const local = io.sockets.sockets.get(socket.id);
    if (!local?.data.claims) continue;
    try {
      local.data.user = await resolveSession(local.data.claims, null, { countsAsActivity: false });
    } catch (err) {
      endSocket(local, err.code || 'SESSION_REVOKED');
    }
  }
}

// Ocupación de la sede (tras cada entrada o salida)
async function publishOccupancy(siteId) {
  const { rows } = await query(
    `SELECT s.capacity, (SELECT count(*) FROM entries e WHERE e.site_id = s.id AND e.status = 'OPEN') AS inside
       FROM sites s WHERE s.id = $1`,
    [siteId],
  );
  if (!rows[0]) return;
  const { inside, capacity } = rows[0];
  publish(siteId, 'occupancy:changed', {
    inside,
    capacity,
    occupancy: capacity ? Math.round((inside / capacity) * 100) : null,
  });
}

// Mensualidades por vencer / en mora de la sede
async function publishMonthlyAlerts(siteId) {
  const monthly = require('../services/monthly.service');
  publish(siteId, 'monthly:alerts', { alerts: await monthly.alerts(siteId) });
}

function initRealtime(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: env.corsOrigin, credentials: true },
    serveClient: false,
  });
  io.use(authenticateSocket);

  io.on('connection', async (socket) => {
    const { user } = socket.data;
    socket.join(`session:${user.sessionId}`);
    socket.join(`user:${user.id}`);
    const sites = await siteIdsFor(user);
    sites.forEach((id) => socket.join(siteRoom(id)));
    socket.emit('ready', { sites });
  });

  // Reenvío de eventos de dominio a la sala de su sede
  const onSiteEvent = (evt) => {
    io.to(siteRoom(evt.siteId)).emit('event', evt);
    if (evt.type === 'entry:created' || evt.type === 'entry:exited') {
      publishOccupancy(evt.siteId).catch(() => {});
    }
    if (evt.type === 'monthly:changed') publishMonthlyAlerts(evt.siteId).catch(() => {});
  };
  const onSessionEnded = ({ sessionId, reason }) => {
    io.in(`session:${sessionId}`).fetchSockets().then((list) => list.forEach((s) => endSocket(s, reason)));
  };
  const onUserEnded = ({ userId, reason }) => {
    io.in(`user:${userId}`).fetchSockets().then((list) => list.forEach((s) => endSocket(s, reason)));
  };
  bus.on('site-event', onSiteEvent);
  bus.on('session-ended', onSessionEnded);
  bus.on('user-sessions-ended', onUserEnded);

  // Revalidación periódica de sesiones y alertas de mensualidades
  const revalidate = setInterval(() => revalidateAll().catch(() => {}), REVALIDATE_MS);
  const alerts = setInterval(async () => {
    try {
      const { rows } = await query('SELECT id FROM sites WHERE is_active');
      for (const r of rows) await publishMonthlyAlerts(r.id);
    } catch {
      /* se reintenta en la próxima vuelta */
    }
  }, ALERTS_EVERY_MS);
  revalidate.unref?.();
  alerts.unref?.();

  return {
    io,
    close: () =>
      new Promise((resolve) => {
        clearInterval(revalidate);
        clearInterval(alerts);
        bus.off('site-event', onSiteEvent);
        bus.off('session-ended', onSessionEnded);
        bus.off('user-sessions-ended', onUserEnded);
        io.close(() => resolve());
        io = null;
      }),
    revalidateAll,
  };
}

module.exports = { initRealtime };
