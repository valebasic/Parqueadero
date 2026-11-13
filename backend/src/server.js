// Punto de entrada: levanta el servidor HTTP.
// Socket.IO (tiempo real) comparte este mismo servidor y puerto.
const http = require('http');
const env = require('./config/env');
const { createApp } = require('./app');
const { closePool } = require('./db/pool');
const { assertSecurityConfig } = require('./config/security');
const { scheduleDailyBackups } = require('./services/backup.service');
const { initRealtime } = require('./realtime');
const { scheduleMonthlyReminders } = require('./services/notification.service');

// Sin JWT_SECRET la API no arranca
try {
  assertSecurityConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const server = http.createServer(createApp());
const realtime = initRealtime(server);

server.listen(env.port, () => {
  console.log(`Nexo API escuchando en http://localhost:${env.port} (${env.nodeEnv})`);
});

// Respaldo diario con pg_dump (si BACKUP_HOUR está configurado)
const stopBackups = scheduleDailyBackups();
// Avisos de mensualidad: revisa al arrancar y cada hora; envía de NOTIFY_HOUR a NOTIFY_UNTIL_HOUR (8 a 21, hora de Colombia)
const stopReminders = scheduleMonthlyReminders();

// Cierre ordenado: deja de aceptar conexiones y libera el pool de PostgreSQL
function shutdown(signal) {
  console.log(`${signal} recibido, cerrando servidor...`);
  stopBackups();
  stopReminders();
  realtime.close();
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
