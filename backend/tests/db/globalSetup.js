// Antes de las pruebas de integración: recrea la base de PRUEBAS con migraciones y seed.
const crypto = require('crypto');

module.exports = async function globalSetup() {
  process.env.NODE_ENV = 'test';
  // El seed exige una contraseña; en pruebas basta una aleatoria
  if (!process.env.SEED_ADMIN_PASSWORD) {
    process.env.SEED_ADMIN_PASSWORD = crypto.randomBytes(12).toString('hex');
  }
  const { resetDatabase } = require('../../src/db/reset');
  const { closePool } = require('../../src/db/pool');
  try {
    await resetDatabase({ log: () => {} });
  } finally {
    await closePool();
  }
};
