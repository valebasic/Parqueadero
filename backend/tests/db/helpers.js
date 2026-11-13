// Utilidades para las pruebas de integración.
const request = require('supertest');
const { createApp } = require('../../src/app');
const { query } = require('../../src/db/pool');
const { execFileSync } = require('child_process');
const path = require('path');
const { hashPassword } = require('../../src/services/password.service');

const app = createApp();
const DEFAULT_PASSWORD = 'Prueba2026x';

// Base de pruebas limpia: esquema, migraciones y seed (sede FACA, zona Principal, AG Felipe).
// Corre `db:reset` en un proceso aparte porque node-pg-migrate es un módulo ES y Jest (CommonJS)
// no puede cargarlo con import() dentro de sus pruebas.
async function freshDatabase() {
  execFileSync(process.execPath, [path.join(__dirname, '../../src/db/reset.js')], {
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'pipe',
  });
}

async function createSite(code, name) {
  const { rows } = await query('INSERT INTO sites (code, name) VALUES ($1, $2) RETURNING id', [code, name]);
  await query("INSERT INTO zones (site_id, name) VALUES ($1, 'Principal')", [rows[0].id]);
  return rows[0].id;
}

async function siteIdByCode(code) {
  const { rows } = await query('SELECT id FROM sites WHERE code = $1', [code]);
  return rows[0].id;
}

// Crea un usuario directamente en la base (sin pasar por la API)
async function createUser({ username, role, siteIds = [], password = DEFAULT_PASSWORD, isActive = true }) {
  const { rows } = await query(
    `INSERT INTO users (username, full_name, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [username, `Usuario ${username}`, await hashPassword(password), role, isActive],
  );
  const id = rows[0].id;
  for (const siteId of siteIds) {
    await query('INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)', [id, siteId]);
  }
  return id;
}

function login(username, password = DEFAULT_PASSWORD) {
  return request(app).post('/api/auth/login').send({ username, password });
}

// Inicia sesión y devuelve { token, cookie, user, auth } (auth = encabezado listo para .set())
async function loginAs(username, password = DEFAULT_PASSWORD) {
  const res = await login(username, password);
  if (res.status !== 200) throw new Error(`login de ${username} falló: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = res.headers['set-cookie'].find((c) => c.startsWith('nexo_rt='));
  return {
    token: res.body.data.accessToken,
    cookie: cookie.split(';')[0],
    user: res.body.data.user,
    auth: ['Authorization', `Bearer ${res.body.data.accessToken}`],
  };
}

async function auditCount(action, where = {}) {
  const { rows } = await query(
    `SELECT count(*) AS n FROM audit_log
      WHERE action = $1 AND ($2::int IS NULL OR user_id = $2) AND ($3::text IS NULL OR entity_id = $3)`,
    [action, where.userId ?? null, where.entityId == null ? null : String(where.entityId)],
  );
  return rows[0].n;
}

module.exports = {
  app,
  DEFAULT_PASSWORD,
  freshDatabase,
  createSite,
  siteIdByCode,
  createUser,
  login,
  loginAs,
  auditCount,
};
