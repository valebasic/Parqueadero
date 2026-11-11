// Carga la configuración desde variables de entorno (.env).
// Ningún valor sensible vive en el código: todo sale de process.env.
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const nodeEnv = process.env.NODE_ENV || 'development';
const isTest = nodeEnv === 'test';

// URL de conexión: DATABASE_URL (o TEST_DATABASE_URL en pruebas) tiene prioridad;
// si no está, se arma con DB_HOST, DB_PORT, DB_USER, DB_PASSWORD y DB_NAME (los mismos que usa docker-compose).
function buildDatabaseUrl() {
  const explicit = isTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (explicit) return explicit;

  const { DB_HOST = 'localhost', DB_PORT = '5432', DB_USER, DB_PASSWORD = '', DB_NAME } = process.env;
  const dbName = isTest ? process.env.DB_NAME_TEST || (DB_NAME && `${DB_NAME}_test`) : DB_NAME;
  if (!DB_USER || !dbName) return '';

  const user = encodeURIComponent(DB_USER);
  const password = DB_PASSWORD ? `:${encodeURIComponent(DB_PASSWORD)}` : '';
  return `postgres://${user}${password}@${DB_HOST}:${DB_PORT}/${encodeURIComponent(dbName)}`;
}

const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest,
  port: Number.parseInt(process.env.PORT, 10) || 3000,
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  databaseUrl: buildDatabaseUrl(),
  // Zona horaria de las sesiones de PostgreSQL (fechas "de hoy", cortes por día, etc.)
  timezone: process.env.APP_TIMEZONE || 'America/Bogota',
};

module.exports = env;
