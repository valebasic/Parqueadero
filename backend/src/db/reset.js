// Recrea la base desde cero: borra el esquema public, aplica todas las migraciones y carga el seed.
// BORRA TODOS LOS DATOS. Se niega a correr con NODE_ENV=production.
const env = require('../config/env');
const { query, closePool } = require('./pool');
const { runMigrations } = require('./migrate');
const { seed } = require('./seed');

async function resetDatabase({ log = console.log } = {}) {
  if (env.isProduction) {
    throw new Error('db:reset está bloqueado con NODE_ENV=production');
  }
  log('Borrando el esquema public...');
  await query('DROP SCHEMA IF EXISTS public CASCADE');
  await query('CREATE SCHEMA public');
  log('Aplicando migraciones...');
  await runMigrations({ direction: 'up', log: () => {} });
  log('Cargando seed...');
  await seed({ log });
}

module.exports = { resetDatabase };

if (require.main === module) {
  resetDatabase()
    .then(() => console.log('Base de datos recreada.'))
    .catch((err) => {
      console.error(err.message || err.code || err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
