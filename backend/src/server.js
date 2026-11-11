// Punto de entrada: levanta el servidor HTTP.
// Socket.IO se acoplará a este mismo servidor en la Fase 6.
const http = require('http');
const env = require('./config/env');
const { createApp } = require('./app');
const { closePool } = require('./db/pool');

const server = http.createServer(createApp());

server.listen(env.port, () => {
  console.log(`Nexo API escuchando en http://localhost:${env.port} (${env.nodeEnv})`);
});

// Cierre ordenado: deja de aceptar conexiones y libera el pool de PostgreSQL
function shutdown(signal) {
  console.log(`${signal} recibido, cerrando servidor...`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
