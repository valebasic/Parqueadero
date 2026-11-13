// Pool de conexiones a PostgreSQL (driver `pg`).
// Se crea de forma perezosa: la API arranca y responde /api/health aunque la base no esté disponible.
const { Pool, types } = require('pg');
const env = require('../config/env');

// DATE → texto 'AAAA-MM-DD' (por defecto pg lo convierte a Date en la zona del servidor y puede correr el día)
types.setTypeParser(types.builtins.DATE, (value) => value);
// BIGINT (ids, COUNT, SUM de montos) → número. Los montos en COP están muy por debajo de 2^53.
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

let pool = null;

function getPool() {
  if (!pool) {
    if (!env.databaseUrl) {
      throw new Error('La conexión a PostgreSQL no está configurada (ver backend/.env.example)');
    }
    pool = new Pool({
      connectionString: env.databaseUrl,
      // Todas las sesiones trabajan en hora de Colombia
      options: `-c timezone=${env.timezone}`,
    });
  }
  return pool;
}

// Atajo para consultas parametrizadas: query('SELECT ... WHERE id = $1', [id])
function query(text, params) {
  return getPool().query(text, params);
}

// Ejecuta fn(client) dentro de una transacción; hace ROLLBACK si fn lanza un error.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, withTransaction, closePool };
