// Pool de conexiones a PostgreSQL (driver `pg`).
// Se crea de forma perezosa: la API arranca y responde /api/health aunque la base no esté disponible.
const { Pool } = require('pg');
const env = require('../config/env');

let pool = null;

function getPool() {
  if (!pool) {
    if (!env.databaseUrl) {
      throw new Error('DATABASE_URL no está configurada (ver backend/.env.example)');
    }
    pool = new Pool({ connectionString: env.databaseUrl });
  }
  return pool;
}

// Atajo para consultas parametrizadas: query('SELECT ... WHERE id = $1', [id])
function query(text, params) {
  return getPool().query(text, params);
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, closePool };
