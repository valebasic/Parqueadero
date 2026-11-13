// Ejecuta las migraciones SQL de src/db/migrations con node-pg-migrate.
// Uso: node src/db/migrate.js [up|down] [cantidad]
//   up          aplica todas las pendientes (por defecto)
//   down        revierte la última
//   down 3      revierte las últimas 3
const path = require('path');
const env = require('../config/env');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations({ direction = 'up', count, log = console.log } = {}) {
  if (!env.databaseUrl) {
    throw new Error('La conexión a PostgreSQL no está configurada (ver backend/.env.example)');
  }
  // node-pg-migrate es un módulo ES: se carga con import() desde CommonJS
  const { runner } = await import('node-pg-migrate');
  return runner({
    databaseUrl: env.databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count: count ?? (direction === 'up' ? Infinity : 1),
    migrationsTable: 'pgmigrations',
    singleTransaction: true,
    checkOrder: true,
    log,
  });
}

module.exports = { runMigrations, MIGRATIONS_DIR };

if (require.main === module) {
  const [direction = 'up', countArg] = process.argv.slice(2);
  if (!['up', 'down'].includes(direction)) {
    console.error('Uso: node src/db/migrate.js [up|down] [cantidad]');
    process.exit(1);
  }
  const count = countArg ? Number.parseInt(countArg, 10) : undefined;
  runMigrations({ direction, count })
    .then((applied) => {
      console.log(applied.length ? `Migraciones ${direction}: ${applied.length}` : 'No hay migraciones pendientes.');
    })
    .catch((err) => {
      console.error(err.message || err.code || err);
      process.exit(1);
    });
}
